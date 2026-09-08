/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { Card } from "@components/Card";
import { Paragraph } from "@components/Paragraph";
import { copyWithToast } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { useAwaiter } from "@utils/react";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { findStoreLazy } from "@webpack";
import { Button, Constants, MaskedLink, Modal, React, RestAPI, SearchableSelect, TextInput, openModal, showToast, Toasts, UserStore, useEffect, useState } from "@webpack/common";

import {
    evaluateStreamObservation,
    evaluateStreamClaim,
    initialStreamClaimState,
    type StreamClaimState,
    type StreamObservation,
    type StreamObservationStatus,
} from "./stability";

type PluginUpdateChannel = "stable" | "beta";

interface PluginUpdateStatus {
    current: string;
    channel: PluginUpdateChannel;
    enabled: boolean;
    pending: boolean;
    pendingVersion?: string;
    lastCheckedAt: number | null;
    lastError: string | null;
}

interface PluginUpdateCheckResult {
    ok: boolean;
    current?: string;
    channel?: PluginUpdateChannel;
    latest?: string;
    available?: boolean;
    pending?: boolean;
    error?: string;
}

interface PluginUpdateResult {
    ok: boolean;
    updated: boolean;
    current?: string;
    latest?: string;
    channel?: PluginUpdateChannel;
    pending?: boolean;
    reloadRequired?: boolean;
    error?: string;
}

interface PluginUpdateNative {
    configurePluginUpdates?: (input: unknown) => Promise<{ enabled: boolean; channel: PluginUpdateChannel }>;
    getPluginUpdateStatus?: () => Promise<PluginUpdateStatus>;
}

const Native = VencordNative?.pluginHelpers?.GoLiveBypass as unknown as (PluginNative<typeof import("./native")> & PluginUpdateNative) | undefined;

const logger = new Logger("GoLiveBypass");

interface RegionStore {
    getPreferredRegion(): string | null;
    getPreferredRegions(): string[] | null;
    shouldIncludePreferredRegion(): boolean;
}

interface VoiceRegion {
    id: string;
    name: string;
    optimal: boolean;
    deprecated: boolean;
    custom: boolean;
}

interface MediaEngineStore {
    supportsInApp(kind: string): boolean;
    supports(kind: string): boolean;
    isSupported(): boolean;
}

interface ApexExperiments {
    getServerAssignment(kind: string, unitId: string, name: string): unknown;
}

interface DiagnosticStore {
    [method: string]: unknown;
}

const RTCRegionStore: RegionStore = findStoreLazy("RTCRegionStore");
const MediaEngineStore: MediaEngineStore = findStoreLazy("MediaEngineStore");
const ApexExperimentStore: ApexExperiments & DiagnosticStore = findStoreLazy("ApexExperimentStore");
const ApplicationStreamingStore: DiagnosticStore = findStoreLazy("ApplicationStreamingStore");
const StreamRTCConnectionStore: DiagnosticStore = findStoreLazy("StreamRTCConnectionStore");
const RTCConnectionStore: DiagnosticStore = findStoreLazy("RTCConnectionStore");

const VIDEO_GUARD = "2026-08-video-guard";

const PLUGIN_VERSION = "2.0.0-beta.1";
const PLUGIN_UPDATE_STATUS_POLL_INTERVAL_MS = 15_000;

const AUTOMATIC = "";
const VOICE_KEYS: "voiceRegion"[] = ["voiceRegion"];
const STREAM_KEYS: "streamRegion"[] = ["streamRegion"];

let original: RegionStore | undefined;
let streamClaimTimer: ReturnType<typeof setInterval> | null = null;
let updateCheckTimer: ReturnType<typeof setTimeout> | null = null;
let lastNotifiedPendingVersion: string | null = null;
let streamClaimState: StreamClaimState = initialStreamClaimState();
let streamClaimStatus = "idle";
let streamClaimProbeFailed = false;
let lastStreamObservationKey: string | null = null;
let lastStreamObservation: {
    status: StreamObservationStatus;
    visibleStreamCount: number | null;
    nativeStreamCount: number | null;
} | null = null;
let lastSelectedStreamRegion: string | null = null;
let onboardingTimer: ReturnType<typeof setTimeout> | null = null;

function normalizedUpdateChannel(value: unknown): PluginUpdateChannel {
    return value === "beta" ? "beta" : "stable";
}

function notifyPendingPluginUpdate(version: unknown): void {
    if (typeof version !== "string" || !version || version === lastNotifiedPendingVersion) return;
    lastNotifiedPendingVersion = version;
    showToast(`GoLiveBypass v${version} pronto; recarregue o Discord para aplicar a atualização.`, Toasts.Type.SUCCESS);
}

interface RegionSelectProps {
    value: string;
    placeholder: string;
    automaticLabel: string;
    onChange(region: string): void;
}

function RegionSelect({ value, placeholder, automaticLabel, onChange }: RegionSelectProps) {
    const [regions, error, pending] = useAwaiter(
        async () => {
            const { body } = await RestAPI.get({ url: Constants.Endpoints.REGIONS() });
            return (body as VoiceRegion[]).filter(region => !region.deprecated && !region.custom);
        },
        { fallbackValue: [] as VoiceRegion[] }
    );

    if (pending) return <Paragraph>Loading the region list.</Paragraph>;
    if (error) return <Paragraph>Discord did not hand over the region list. Log in and reopen settings to try again.</Paragraph>;

    const options = [
        { label: automaticLabel, value: AUTOMATIC },
        ...regions.map(region => ({ label: region.optimal ? `${region.name}, optimal for you` : region.name, value: region.id }))
    ];

    return (
        <SearchableSelect
            placeholder={placeholder}
            maxVisibleItems={8}
            options={options}
            value={options.find(option => option.value === value)?.value}
            onChange={onChange}
            closeOnSelect
        />
    );
}

function VoiceRegionPicker() {
    const { voiceRegion } = settings.use(VOICE_KEYS);

    return (
        <RegionSelect
            value={voiceRegion}
            placeholder="Pick the region your calls should connect through"
            automaticLabel="Automatic, whatever Discord picks"
            onChange={region => settings.store.voiceRegion = region}
        />
    );
}

function StreamRegionPicker() {
    const { streamRegion } = settings.use(STREAM_KEYS);

    return (
        <RegionSelect
            value={streamRegion}
            placeholder="Pick the region your screen share should go through"
            automaticLabel="Same region as your call"
            onChange={region => settings.store.streamRegion = region}
        />
    );
}

interface ProtonSessionCheck {
    valid: boolean;
    username?: string;
    expiresIn?: string;
    code?: "INVALID_SESSION" | "NETWORK_ERROR" | "TIMEOUT" | "MISSING_EXECUTABLE" | "UNKNOWN";
    error?: string;
}

interface PluginOptimizationStatus {
    active: boolean;
    requestId: string | null;
    phase: "ping" | "preparing" | "testing" | "finalizing" | "completed" | "failed" | "cancelled" | null;
    total: number;
    tested: number;
    succeeded: number;
    server?: string;
    pingMs?: number;
    downloadMbps?: number;
    uploadMbps?: number;
    error?: string;
    updatedAt: number | null;
}

type OnboardingPage = "account" | "route" | "ready";

const onboardingBoxStyle = {
    background: "var(--background-secondary-alt)",
    border: "1px solid var(--background-modifier-accent)",
    borderRadius: "8px",
    padding: "16px",
};

function OnboardingSteps({ page }: { page: OnboardingPage }) {
    const active = page === "account" ? 0 : 1;
    return (
        <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }} aria-label="Etapas da configuração">
            {["1  Conta Proton", "2  Rota WireGuard"].map((label, index) => (
                <div
                    key={label}
                    style={{
                        flex: 1,
                        padding: "8px 10px",
                        borderRadius: "6px",
                        background: index <= active ? "var(--brand-experiment-560)" : "var(--background-tertiary)",
                        color: index <= active ? "var(--white-500)" : "var(--text-muted)",
                        fontSize: "12px",
                        fontWeight: 600,
                        textAlign: "center",
                    }}
                >
                    {label}
                </div>
            ))}
        </div>
    );
}

function PluginOnboardingModal({ modalProps }: { modalProps: RenderModalProps }) {
    const [page, setPage] = useState<OnboardingPage>("account");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [twoFactorCode, setTwoFactorCode] = useState("");
    const [session, setSession] = useState<ProtonSessionCheck | null>(null);
    const [sessionLoading, setSessionLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [optimization, setOptimization] = useState<PluginOptimizationStatus | null>(null);
    const [requestId, setRequestId] = useState<string | null>(null);

    const complete = () => {
        settings.store.onboardingCompleted = true;
        modalProps.onClose();
    };

    const checkSession = async (value: string) => {
        if (!Native || !value.trim()) {
            setSession({ valid: false, code: "INVALID_SESSION", error: "Informe o usuário Proton." });
            return null;
        }
        setSessionLoading(true);
        try {
            const result = await Native.checkProtonSession(value.trim()) as ProtonSessionCheck;
            setSession(result);
            return result;
        } catch (checkError) {
            const result: ProtonSessionCheck = {
                valid: false,
                code: "NETWORK_ERROR",
                error: checkError instanceof Error ? checkError.message : "Não foi possível verificar a sessão Proton.",
            };
            setSession(result);
            return result;
        } finally {
            setSessionLoading(false);
        }
    };

    useEffect(() => {
        let disposed = false;
        const load = async () => {
            if (!Native) {
                if (!disposed) setSessionLoading(false);
                return;
            }
            try {
                const saved = await Native.getProtonSettings();
                const record = saved as { protonUsername?: unknown; sessionUsername?: unknown };
                const savedUsername = typeof record.sessionUsername === "string" && record.sessionUsername.trim()
                    ? record.sessionUsername.trim()
                    : typeof record.protonUsername === "string" ? record.protonUsername.trim() : "";
                if (disposed) return;
                if (savedUsername) {
                    setUsername(savedUsername);
                    const result = await checkSession(savedUsername);
                    if (!disposed && result?.valid) setError(null);
                } else {
                    setSessionLoading(false);
                }
            } catch (loadError) {
                if (!disposed) {
                    setSessionLoading(false);
                    setError(loadError instanceof Error ? loadError.message : "Não foi possível ler a sessão Proton.");
                }
            }
        };
        void load();
        return () => { disposed = true; };
    }, []);

    useEffect(() => {
        if (page !== "route" || !Native) return;
        let disposed = false;
        const refresh = async () => {
            try {
                const next = await Native.getProtonOptimizationStatus() as PluginOptimizationStatus;
                if (!disposed) setOptimization(next);
            } catch (statusError) {
                if (!disposed) logger.error("Falha ao ler progresso da otimização Proton", statusError);
            }
        };
        void refresh();
        const timer = setInterval(() => void refresh(), 750);
        return () => {
            disposed = true;
            clearInterval(timer);
        };
    }, [page]);

    const continueToRoute = async () => {
        if (!Native || busy || sessionLoading || !username.trim()) return;
        setError(null);
        setBusy(true);
        try {
            let verified = session?.valid && session.username?.toLowerCase() === username.trim().toLowerCase() ? session : null;
            if (!verified) {
                if (!password) {
                    setError("Informe a senha para iniciar uma nova sessão ou renovar a sessão atual.");
                    return;
                }
                const loginResult = await Native.loginProton({ username: username.trim(), password, twoFactorCode });
                if (!loginResult.success) {
                    const code = loginResult.code;
                    if (code === "TWO_FACTOR_REQUIRED") setError("Esta conta exige o código 2FA.");
                    else if (code === "NETWORK_ERROR" || code === "TIMEOUT") setError("O login não conseguiu alcançar o Proton. Verifique a rede e tente novamente.");
                    else setError(loginResult.error || loginResult.message || "Não foi possível entrar no Proton.");
                    return;
                }
                setPassword("");
                setTwoFactorCode("");
                const checked = await checkSession(username);
                if (!checked) {
                    setError("Não foi possível validar a sessão Proton.");
                    return;
                }
                if (!checked.valid) {
                    if (checked.code === "NETWORK_ERROR" || checked.code === "TIMEOUT") {
                        setError("Login concluído, mas a validação da sessão está temporariamente indisponível pela rede. Tente novamente antes de otimizar.");
                    } else {
                        setError(checked.error || "A sessão salva não passou na validação.");
                    }
                    return;
                }
                verified = checked;
            }
            if (!verified) return;
            setSession(verified);
            setPage("route");
        } catch (continueError) {
            setError(continueError instanceof Error ? continueError.message : "Não foi possível concluir a etapa da conta Proton.");
        } finally {
            setBusy(false);
        }
    };

    const optimizeRoute = async () => {
        if (!Native || busy) return;
        const nextRequestId = `plugin-onboarding-${Date.now()}`;
        setRequestId(nextRequestId);
        setBusy(true);
        setError(null);
        try {
            const result = await Native.optimizeProtonRoute({
                requestId: nextRequestId,
                speedTest: true,
                country: settings.store.protonCountry,
                freeOnly: settings.store.protonFreeOnly,
                autoPing: settings.store.protonAutoPing,
            });
            if (!result.success) throw new Error(result.error || "Não foi possível otimizar a rota Proton.");
            setOptimization({
                active: false,
                requestId: nextRequestId,
                phase: "completed",
                total: result.speedTested || 0,
                tested: result.speedTested || 0,
                succeeded: result.speedSucceeded || 0,
                server: result.server,
                pingMs: result.pingMs,
                downloadMbps: result.downloadMbps,
                uploadMbps: result.uploadMbps,
                updatedAt: Date.now(),
            });
            setPage("ready");
        } catch (optimizeError) {
            setError(optimizeError instanceof Error ? optimizeError.message : "A otimização Proton falhou.");
        } finally {
            setBusy(false);
        }
    };

    const cancelOptimization = async () => {
        if (!Native || !requestId || !busy) return;
        try {
            await Native.cancelProtonOptimization(requestId);
        } catch (cancelError) {
            setError(cancelError instanceof Error ? cancelError.message : "Não foi possível cancelar a otimização.");
        }
    };

    const progress = optimization;
    const progressPercent = progress && progress.total > 0
        ? Math.min(100, Math.round((progress.tested / progress.total) * 100))
        : null;
    const phaseLabel = progress?.phase === "ping" ? "medindo latência"
        : progress?.phase === "testing" ? "testando servidores"
            : progress?.phase === "finalizing" ? "finalizando a configuração"
                : progress?.phase === "completed" ? "rota preparada"
                    : progress?.phase === "failed" ? "otimização falhou"
                        : progress?.phase === "cancelled" ? "otimização cancelada"
                            : "preparando a seleção";

    const actions = page === "account" ? [
        { text: "Fazer depois", variant: "secondary" as const, onClick: complete },
        { text: busy ? "Entrando…" : "Continuar para rota", variant: "primary" as const, onClick: () => void continueToRoute(), disabled: busy || sessionLoading || !username.trim() },
    ] : page === "route" ? [
        { text: "Voltar", variant: "secondary" as const, onClick: () => { if (!busy) setPage("account"); }, disabled: busy },
        busy
            ? { text: "Cancelar otimização", variant: "danger" as const, onClick: () => void cancelOptimization() }
            : { text: progress?.phase === "completed" ? "Continuar" : "Otimizar rota", variant: "primary" as const, onClick: progress?.phase === "completed" ? () => setPage("ready") : () => void optimizeRoute() },
    ] : [
        { text: "Concluir configuração", variant: "primary" as const, onClick: complete },
    ];

    if (!Native) {
        return <Modal {...modalProps} title="Configuração do GoLiveBypass" size="md" actions={[{ text: "Fechar", variant: "secondary", onClick: modalProps.onClose }]}>
            <Paragraph>O transporte WireGuard do plugin está disponível somente no Discord desktop Windows x64 nesta versão.</Paragraph>
        </Modal>;
    }

    return (
        <Modal {...modalProps} title="Configurar o GoLiveBypass" size="md" actions={actions}>
            <OnboardingSteps page={page} />
            {page === "account" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    <Paragraph><strong>Conecte sua conta ProtonVPN</strong></Paragraph>
                    <Paragraph>A sessão é validada e fica somente na pasta privada do plugin. Senhas e códigos nunca são exibidos no diagnóstico.</Paragraph>
                    <TextInput value={username} onChange={value => { setUsername(value); if (session?.username && session.username !== value.trim()) setSession(null); }} placeholder="Usuário ProtonVPN" disabled={busy} />
                    <TextInput value={password} onChange={setPassword} placeholder="Senha ProtonVPN" type="password" disabled={busy} />
                    <TextInput value={twoFactorCode} onChange={setTwoFactorCode} placeholder="Código 2FA (se solicitado)" disabled={busy} />
                    {sessionLoading && <Paragraph>Verificando a sessão salva…</Paragraph>}
                    {!sessionLoading && session?.valid && <Paragraph><strong>Sessão válida</strong>{session.expiresIn ? ` · expira ${session.expiresIn}` : ""}. Você pode continuar sem digitar a senha.</Paragraph>}
                    {!sessionLoading && session && !session.valid && <Paragraph><strong>{session.code === "NETWORK_ERROR" || session.code === "TIMEOUT" ? "Rede indisponível para verificar a sessão" : "Sessão precisa ser renovada"}</strong>{session.error ? ` · ${session.error}` : ""}</Paragraph>}
                    {error && <Paragraph><strong>{error}</strong></Paragraph>}
                    {!!username.trim() && !sessionLoading && <Button onClick={() => void checkSession(username)} disabled={busy}>Verificar sessão novamente</Button>}
                </div>
            )}
            {page === "route" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    <Paragraph><strong>Prepare e otimize sua rota</strong></Paragraph>
                    <Paragraph>O plugin vai selecionar uma configuração WireGuard e testar os servidores Proton elegíveis. O túnel continua isolado aos executáveis do Discord.</Paragraph>
                    <div style={onboardingBoxStyle} role="status" aria-live="polite">
                        <div style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}><strong>Estado da rota</strong><span>{phaseLabel}</span></div>
                        {progressPercent !== null && <progress value={progressPercent} max={100} style={{ width: "100%", marginTop: "12px" }} />}
                        {progress && progress.total > 0 && <Paragraph>{progress.tested} de {progress.total} servidores testados · {progress.succeeded} aprovados</Paragraph>}
                        {progress?.server && <Paragraph>Servidor selecionado: {progress.server}</Paragraph>}
                        {typeof progress?.pingMs === "number" && <Paragraph>Latência medida: {progress.pingMs} ms</Paragraph>}
                        {progress?.phase === "completed" && <Paragraph>A configuração foi salva; a ativação da VPN continua sendo uma ação separada.</Paragraph>}
                    </div>
                    {error && <Paragraph><strong>{error}</strong></Paragraph>}
                </div>
            )}
            {page === "ready" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    <Paragraph><strong>Configuração concluída</strong></Paragraph>
                    <div style={onboardingBoxStyle} role="status" aria-live="polite">
                        <Paragraph>A rota Proton foi preparada com sucesso. Ative o túnel quando quiser pelo painel do plugin; o Discord não será reiniciado automaticamente.</Paragraph>
                        {progress?.server && <Paragraph>Servidor escolhido: {progress.server}</Paragraph>}
                        {typeof progress?.downloadMbps === "number" && typeof progress.uploadMbps === "number" && <Paragraph>Teste medido: {progress.downloadMbps} Mbps down · {progress.uploadMbps} Mbps up</Paragraph>}
                    </div>
                </div>
            )}
        </Modal>
    );
}

function openPluginOnboarding() {
    openModal(props => <PluginOnboardingModal modalProps={props} />);
}

function AboutPlugin() {
    return (
        <>
            <section>
                <Paragraph><strong>Assistente de configuração</strong> — configure sua conta Proton e prepare a rota WireGuard dentro do Discord.</Paragraph>
                <Button onClick={openPluginOnboarding}>Abrir guia de configuração</Button>
            </section>
            <VpnPanel />
            <PluginUpdateSettings />
            <Paragraph>
                Feito por bezumiya. Código e issues no <MaskedLink href="https://github.com/bezumiya/GoLiveBypass">GitHub</MaskedLink>, e novidades no <MaskedLink href="https://twitter.com/obezumiya">Twitter</MaskedLink>.
            </Paragraph>
        </>
    );
}

function PluginUpdateSettings() {
    const { updateChannel, autoUpdate } = settings.use(["updateChannel", "autoUpdate"]);
    const [state, setState] = useState<{ label: string; tone: "neutral" | "success" | "warning"; available?: boolean }>({
        label: `v${PLUGIN_VERSION} · instalada`, tone: "neutral"
    });
    const [status, setStatus] = useState<PluginUpdateStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [operation, setOperation] = useState<"checking" | "updating" | null>(null);

    const refreshStatus = async () => {
        const getStatus = Native?.getPluginUpdateStatus;
        if (typeof getStatus !== "function") return;
        try {
            const next = await getStatus();
            setStatus(next);
            if (next.pending) {
                notifyPendingPluginUpdate(next.pendingVersion);
                const version = next.pendingVersion ? `v${next.pendingVersion}` : "a nova versão";
                setState({ label: `${version} pronta; recarregue o Discord`, tone: "warning" });
            } else if (next.lastError) {
                setState({ label: `v${next.current || PLUGIN_VERSION} · atualização falhou`, tone: "neutral" });
            }
        } catch (error) {
            logger.error("Falha ao consultar o estado do updater do plugin", error);
        }
    };

    const check = async () => {
        if (!Native || busy) return;
        setBusy(true);
        setOperation("checking");
        try {
            const result = await Native.checkPluginUpdate() as PluginUpdateCheckResult;
            const current = result.current || PLUGIN_VERSION;
            if (!result.ok) {
                const detail = result.error ? ` · ${result.error.slice(0, 48)}` : "";
                setState({ label: `v${current} · verificação falhou${detail}`, tone: "neutral" });
            } else if (result.pending) {
                const version = result.latest ? `v${result.latest}` : "a nova versão";
                notifyPendingPluginUpdate(result.latest);
                setState({ label: `${version} pronta; recarregue o Discord`, tone: "warning" });
            } else if (result.available) {
                setState({ label: `v${current} · v${result.latest || "nova"} disponível`, tone: "warning", available: true });
            } else {
                setState({ label: `v${current} · sem atualização disponível`, tone: "success" });
            }
        } catch (error) {
            // Native.checkPluginUpdate() em si nunca rejeita (o corpo inteiro do lado nativo
            // ja esta em try/catch, sempre resolve com {ok:true|false,...}) -- mas a chamada
            // IPC por baixo pode rejeitar sozinha (ex.: logo apos um self-update do plugin,
            // com o handler ipcMain.handle temporariamente desalinhado). update(), a funcao
            // irma logo abaixo, ja trata isso; check() nao tratava, deixando uma rejeicao sem
            // dono no console do renderer (inofensivo aqui -- so o processo PRINCIPAL derruba
            // tudo com promise sem tratamento -- mas inconsistente e sem feedback pra pessoa).
            const detail = error instanceof Error ? ` · ${error.message.slice(0, 48)}` : "";
            setState({ label: `v${PLUGIN_VERSION} · verificação falhou${detail}`, tone: "neutral" });
        } finally {
            setBusy(false);
            setOperation(null);
        }
    };

    useEffect(() => {
        let disposed = false;
        const configure = async () => {
            try {
                const configureUpdates = Native?.configurePluginUpdates;
                if (typeof configureUpdates === "function") {
                    await configureUpdates({
                        enabled: autoUpdate,
                        channel: normalizedUpdateChannel(updateChannel)
                    });
                }
                if (!disposed) await refreshStatus();
            } catch (error) {
                if (!disposed) logger.error("Falha ao configurar o updater do plugin", error);
            }
        };
        void configure();

        const timer = setInterval(() => {
            if (!disposed) void refreshStatus();
        }, PLUGIN_UPDATE_STATUS_POLL_INTERVAL_MS);
        return () => {
            disposed = true;
            clearInterval(timer);
        };
    }, [updateChannel, autoUpdate]);

    const update = async () => {
        if (!Native || busy) return;
        setBusy(true);
        setOperation("updating");
        try {
            const result = await Native.updatePlugin() as PluginUpdateResult;
            if (!result.ok) throw new Error(result.error || "O updater recusou a atualização.");
            if (result.updated || result.pending || result.reloadRequired) {
                const version = result.latest || result.current;
                notifyPendingPluginUpdate(version);
                setState({
                    label: version ? `v${version} pronta; recarregue o Discord` : "Atualização pronta; recarregue o Discord",
                    tone: "warning"
                });
                await refreshStatus();
            } else {
                setState({ label: `v${result.current || PLUGIN_VERSION} · sem atualização disponível`, tone: "success" });
            }
        } catch (error) {
            setState({ label: `v${PLUGIN_VERSION} · atualização falhou`, tone: "warning" });
            showToast(`GoLiveBypass não conseguiu atualizar: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
            setOperation(null);
        }
    };

    const channelLabel = updateChannel === "beta" ? "Beta (opt-in)" : "Estável";
    const checkedLabel = typeof status?.lastCheckedAt === "number"
        ? ` · última consulta ${new Date(status.lastCheckedAt).toLocaleTimeString()}`
        : "";
    const cardVariant = busy ? "brand" : state.tone === "warning" ? "warning" : state.tone === "success" ? "success" : "primary";
    const operationLabel = operation === "checking"
        ? "Verificando atualizações…"
        : operation === "updating"
            ? "Baixando e preparando a atualização…"
            : state.label;

    return (
        <Card variant={cardVariant} defaultPadding>
            <section aria-label="Estado das atualizações do GoLiveBypass">
                <Paragraph>
                    <strong>Atualizações do GoLiveBypass</strong> — canal {channelLabel}; automática {autoUpdate ? "ligada" : "desligada"}{checkedLabel}
                </Paragraph>
                <Paragraph>
                    <strong>{operationLabel}</strong>{" "}
                    <Button onClick={() => void check()} disabled={busy}>{busy ? "Em andamento…" : "Verificar"}</Button>{" "}
                    {state.available && <Button onClick={() => void update()} disabled={busy}>Atualizar</Button>}
                </Paragraph>
                {status?.pending && <Paragraph>Atualização {status.pendingVersion ? `v${status.pendingVersion}` : "preparada"} pronta; recarregue o Discord manualmente para aplicar.</Paragraph>}
                {status?.lastError && <Paragraph>Último erro do updater: {status.lastError.slice(0, 240)}</Paragraph>}
            </section>
        </Card>
    );
}

const settings = definePluginSettings({
    voiceRegion: {
        type: OptionType.COMPONENT,
        component: VoiceRegionPicker,
        default: AUTOMATIC
    },
    streamRegion: {
        type: OptionType.COMPONENT,
        component: StreamRegionPicker,
        default: AUTOMATIC
    },
    updateChannel: {
        type: OptionType.SELECT,
        description: "Escolha se o updater deve receber somente versões estáveis ou também versões beta.",
        options: [
            { label: "Estável", value: "stable", default: true },
            { label: "Beta", value: "beta" }
        ]
    },
    autoUpdate: {
        type: OptionType.BOOLEAN,
        description: "Verificar, baixar e preparar atualizações em segundo plano. O Discord nunca é reiniciado automaticamente.",
        default: true
    },
    onboardingCompleted: {
        type: OptionType.BOOLEAN,
        description: "Indica se o assistente inicial já foi concluído.",
        default: false,
        hidden: true,
    },
    vpnMode: {
        type: OptionType.SELECT,
        description: "Rota WireGuard isolada para este Discord. O restante do computador continua usando a rede normal.",
        options: [
            { label: "ProtonVPN (recomendado)", value: "proton", default: true },
            { label: "Arquivo WireGuard personalizado", value: "custom" }
        ]
    },
    customConfigPath: {
        type: OptionType.STRING,
        description: "Caminho absoluto de um .conf WireGuard. Ele será copiado para a pasta privada do plugin e filtrado somente para os executáveis deste Discord.",
        default: ""
    },
    protonUsername: {
        type: OptionType.STRING,
        description: "Usuário da conta ProtonVPN. A sessão fica somente na pasta privada do plugin.",
        default: ""
    },
    protonCountry: {
        type: OptionType.STRING,
        description: "Países Proton preferidos, em códigos de duas letras separados por vírgula. Vazio deixa o Proton escolher.",
        default: "",
        isValid: (value: string) => value.trim() === "" || value.trim().split(",").every(part => /^[A-Za-z]{2}$/.test(part.trim()))
            || "Use códigos de país de duas letras, por exemplo US, NL."
    },
    protonFreeOnly: {
        type: OptionType.BOOLEAN,
        description: "Usar somente servidores gratuitos na seleção automática do Proton.",
        default: true
    },
    protonAutoPing: {
        type: OptionType.BOOLEAN,
        description: "Escolher primeiro servidores Proton com menor latência.",
        default: true
    }
});

interface PluginVpnStatus {
    state: string;
    active: boolean;
    message: string;
    externalReason: string | null;
    lastDiagnostic: { detail: string; ok: boolean; kind: string } | null;
}

function VpnPanel() {
    const [status, setStatus] = useState<PluginVpnStatus | null>(null);
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [twoFactorCode, setTwoFactorCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [optimizing, setOptimizing] = useState(false);

    const refresh = async () => {
        if (!Native) return;
        try {
            const [nextStatus, saved] = await Promise.all([Native.getVpnStatus(), Native.getProtonSettings()]);
            setStatus(nextStatus as PluginVpnStatus);
            const savedRecord = saved as { protonUsername?: unknown; sessionUsername?: unknown };
            const savedUsername = typeof savedRecord.protonUsername === "string" && savedRecord.protonUsername
                ? savedRecord.protonUsername
                : savedRecord.sessionUsername;
            if (!username && typeof savedUsername === "string" && savedUsername) setUsername(savedUsername);
        } catch (error) {
            logger.error("Falha ao ler o estado da VPN do plugin", error);
        }
    };

    useEffect(() => {
        void refresh();
        const timer = setInterval(() => void refresh(), 5_000);
        return () => clearInterval(timer);
    }, []);

    const call = async (operation: () => Promise<unknown>, successMessage?: string) => {
        if (busy) return;
        setBusy(true);
        try {
            const result = await operation() as { success?: boolean; error?: string; message?: string };
            if (result.success === false) throw new Error(result.error || result.message || "Operação VPN recusada.");
            if (successMessage) showToast(successMessage, Toasts.Type.SUCCESS);
            await refresh();
        } catch (error) {
            showToast(`GoLiveBypass: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    };

    const login = async () => {
        if (!Native || busy || optimizing) return;
        setBusy(true);
        try {
            const result = await Native.loginProton({ username, password, twoFactorCode });
            if (!result.success) throw new Error(result.error || result.message || "Login Proton recusado.");
            setPassword("");
            setTwoFactorCode("");
            showToast("Sessão Proton salva na pasta privada do plugin.", Toasts.Type.SUCCESS);
            await refresh();
        } catch (error) {
            showToast(`Login Proton: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    };

    const optimize = async () => {
        if (!Native || busy || optimizing) return;
        setOptimizing(true);
        try {
            const result = await Native.optimizeProtonRoute({
                requestId: `plugin-${Date.now()}`,
                speedTest: true,
                country: settings.store.protonCountry,
                freeOnly: settings.store.protonFreeOnly,
                autoPing: settings.store.protonAutoPing
            });
            if (!result.success) throw new Error(result.error || "Não foi possível otimizar a rota Proton.");
            showToast("Rota Proton otimizada. O Discord será reiniciado para aplicar o túnel.", Toasts.Type.SUCCESS);
            await refresh();
        } catch (error) {
            showToast(`Otimização Proton: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
        } finally {
            setOptimizing(false);
        }
    };

    if (!Native) return <Paragraph>A parte desktop do plugin não está disponível nesta instalação.</Paragraph>;

    const statusLabel = status?.active ? `Ativa · ${status.message}` : status?.message || "Consultando o estado da VPN…";
    return (
        <section>
            <Paragraph><strong>VPN do plugin</strong> — {statusLabel}</Paragraph>
            {status?.state === "blocked_external" && <Paragraph>WireSock externo detectado. O plugin não vai pará-lo nem assumir seu túnel.</Paragraph>}
            {status?.state === "recovery_required" && <Paragraph>A última limpeza não foi confirmada. Verifique o log antes de tentar novamente.</Paragraph>}
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <TextInput value={username} onChange={setUsername} placeholder="Usuário ProtonVPN" disabled={busy || optimizing} />
                <TextInput value={password} onChange={setPassword} placeholder="Senha ProtonVPN" type="password" disabled={busy || optimizing} />
                <TextInput value={twoFactorCode} onChange={setTwoFactorCode} placeholder="Código 2FA (se solicitado)" disabled={busy || optimizing} />
                <div>
                    <Button onClick={() => void login()} disabled={busy || optimizing || !username.trim()}>Entrar no Proton</Button>{" "}
                    <Button onClick={() => void optimize()} disabled={busy || optimizing || !username.trim()}>{optimizing ? "Otimizando…" : "Otimizar rota"}</Button>{" "}
                    <Button onClick={() => void call(() => Native.logoutProton(), "Sessão Proton removida.")} disabled={busy || optimizing}>Sair</Button>
                </div>
                <div>
                    <Button onClick={() => void call(() => Native.enable())} disabled={busy || optimizing}>Ativar agora</Button>{" "}
                    <Button onClick={() => void call(() => Native.restoreNetwork(), "Rede restaurada.")} disabled={busy || optimizing}>Restaurar rede</Button>{" "}
                    <Button onClick={() => void call(() => Native.testWireGuardConfig(settings.store.customConfigPath))} disabled={busy || optimizing}>Testar .conf</Button>
                </div>
            </div>
            <Paragraph>
                Windows x64 apenas por enquanto. O túnel usa AllowedApps somente para o executável do Discord e o Update.exe; probes de rota são apenas diagnóstico.
            </Paragraph>
        </section>
    );
}

function forcedRegion() {
    const region = settings.store.voiceRegion;
    if (typeof region !== "string") return null;

    const trimmed = region.trim();
    return trimmed === AUTOMATIC ? null : trimmed;
}

function forceRegion() {
    if (original !== undefined) return;

    const store = RTCRegionStore;
    if (typeof store.getPreferredRegion !== "function"
        || typeof store.getPreferredRegions !== "function"
        || typeof store.shouldIncludePreferredRegion !== "function") {
        showToast("GoLiveBypass could not find Discord's region picker, so your call region is untouched.", Toasts.Type.FAILURE);
        return;
    }

    const saved: RegionStore = {
        getPreferredRegion: store.getPreferredRegion,
        getPreferredRegions: store.getPreferredRegions,
        shouldIncludePreferredRegion: store.shouldIncludePreferredRegion
    };

    store.getPreferredRegion = function () {
        return forcedRegion() ?? saved.getPreferredRegion.call(this);
    };

    store.getPreferredRegions = function () {
        const forced = forcedRegion();
        const ranked = saved.getPreferredRegions.call(this);
        return forced === null ? ranked : [forced, ...(ranked ?? []).filter(region => region !== forced)];
    };

    store.shouldIncludePreferredRegion = function () {
        return forcedRegion() !== null || saved.shouldIncludePreferredRegion.call(this);
    };

    original = saved;
}

function restoreRegion() {
    if (original === undefined) return;

    RTCRegionStore.getPreferredRegion = original.getPreferredRegion;
    RTCRegionStore.getPreferredRegions = original.getPreferredRegions;
    RTCRegionStore.shouldIncludePreferredRegion = original.shouldIncludePreferredRegion;
    original = undefined;
}

function videoIsBlocked() {
    const user = UserStore.getCurrentUser();
    if (user == null) return false;

    const assignment = ApexExperimentStore.getServerAssignment("user", user.id, VIDEO_GUARD);
    if (assignment === null || typeof assignment !== "object") return false;

    // As duas variacoes do experimento desligam video; o balde de controle nao tem nenhuma
    // delas. Ler supportsInApp aqui seria inutil: o patch do plugin deixa esse valor sempre
    // verdadeiro, e a checagem nunca detectaria bloqueio nenhum.
    const { variantId } = assignment as { variantId?: unknown; };
    return variantId === 1 || variantId === 2;
}

// O Logger do Vencord so aparece no console do DevTools, que ninguem abre para relatar um
// problema. Isto vai para o mesmo arquivo do processo principal, entao o registro conta a
// historia inteira num lugar so.
function record(message: string) {
    logger.info(message);
    Native?.logFromRenderer(message).catch(() => {
        // Sem o registro em arquivo ainda resta o console; nao vale quebrar o fluxo por isso.
    });
}

// O que so o renderer enxerga. Sem isto o arquivo mostraria qual saida subiu, mas nunca se o
// servidor aceitou, que e a pergunta que importa.
function recordSession() {
    const user = UserStore.getCurrentUser();
    const assignment = user == null ? "sem usuario" : ApexExperimentStore.getServerAssignment("user", user.id, VIDEO_GUARD);

    record(`sessao aberta | atribuicao do video guard: ${JSON.stringify(assignment)}`);
    record(`  o cliente aceita video? supports ${ask(MediaEngineStore, "supports", "VIDEO")} | supportsInApp ${ask(MediaEngineStore, "supportsInApp", "VIDEO")} | desktop ${ask(MediaEngineStore, "supportsInApp", "DESKTOP_CAPTURE")}`);
    record(`  regiao preferida ${ask(RTCRegionStore, "getPreferredRegion")} | lista ${JSON.stringify(ask(RTCRegionStore, "getPreferredRegions"))} | override instalado ${original !== undefined}`);
}

function reportSession() {
    recordSession();
    if (!Native) return;

    // A conexão do gateway não muda a rota: o túnel WireGuard já nasceu antes do
    // Discord conectar e continua isolado por aplicativo. Este registro é somente
    // diagnóstico e não tenta recarregar ou trocar a saída no meio da mídia.
    Native.getVpnStatus().then(status => {
        record(`sessao aberta | VPN ${status.state} | ativa ${status.active} | ownership ${status.owned}`);
        if (videoIsBlocked()) record("o servidor ainda reporta o guard de video; nenhuma troca automatica de rede foi feita");
    }).catch(error => logger.error("Falha ao consultar a VPN do plugin", error));
}

function ask(store: object, method: string, ...args: unknown[]) {
    const fn = (store as DiagnosticStore)[method];
    if (typeof fn !== "function") return "metodo ausente";

    try {
        return (fn as (...a: unknown[]) => unknown).apply(store, args) ?? null;
    } catch (error) {
        return `erro: ${error instanceof Error ? error.message : String(error)}`;
    }
}

function readStore(store: object, method: string) {
    const fn = (store as DiagnosticStore)[method];
    if (typeof fn !== "function") return { known: false as const, value: null };

    try {
        return { known: true as const, value: (fn as () => unknown).call(store) };
    } catch {
        return { known: false as const, value: null };
    }
}

function collectionCount(value: unknown): number | null {
    if (Array.isArray(value)) return value.length;
    if (value instanceof Set || value instanceof Map) return value.size;
    if (value !== null && typeof value === "object") {
        try {
            return Object.keys(value).length;
        } catch {
            return null;
        }
    }
    return null;
}

function observationText(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const clean = value.trim().replace(/[|\r\n]+/g, "_").slice(0, 200);
    return clean || null;
}

function observationHostname(value: unknown): string | null {
    const raw = observationText(value);
    if (!raw) return null;
    try {
        return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname || null;
    } catch {
        return raw;
    }
}

function readObservationText(store: object, method: string): string | null {
    const result = readStore(store, method);
    return result.known ? observationText(result.value) : null;
}

function readObservationHostname(store: object, method: string): string | null {
    const result = readStore(store, method);
    return result.known ? observationHostname(result.value) : null;
}

function configuredStreamRegion(): string | null {
    const configured = settings.store.streamRegion;
    return typeof configured === "string" && configured.trim() !== AUTOMATIC
        ? observationText(configured)
        : null;
}

// Guarda especifica para o falso "transmitindo"/erro 2001 visto no fogo da
// beta 13. Nao tenta inferir fps nem fechar sockets: as stores do renderer so
// provam que a UI afirma uma Live e se a conexao nativa de stream chegou a
// existir. Dado ausente falha fechado; a unica acao e um aviso manual.
function pollStreamClaimOnce() {
    const claimed = readStore(ApplicationStreamingStore, "getCurrentUserActiveStream");
    const visibleStreams = readStore(ApplicationStreamingStore, "getAllActiveStreams");
    const nativeKeys = readStore(StreamRTCConnectionStore, "getAllActiveStreamKeys");

    const senderClaimed = !claimed.known || claimed.value === undefined
        ? null
        : claimed.value !== null;
    if (senderClaimed === false) lastSelectedStreamRegion = null;
    const now = Date.now();
    const observation: StreamObservation = {
        now,
        senderClaimed,
        visibleStreamCount: visibleStreams.known ? collectionCount(visibleStreams.value) : null,
        nativeStreamCount: nativeKeys.known ? collectionCount(nativeKeys.value) : null,
        voiceState: readObservationText(RTCConnectionStore, "getState"),
        voiceHostname: readObservationHostname(RTCConnectionStore, "getHostname"),
        selectedRegion: lastSelectedStreamRegion ?? configuredStreamRegion(),
    };
    const observationDecision = evaluateStreamObservation(observation);
    lastStreamObservation = {
        status: observationDecision.status,
        visibleStreamCount: observation.visibleStreamCount,
        nativeStreamCount: observation.nativeStreamCount,
    };
    if (observationDecision.key !== lastStreamObservationKey) {
        lastStreamObservationKey = observationDecision.key;
        record(
            `stream.observation | status=${observationDecision.status}` +
            ` claimed=${observation.senderClaimed ?? "unknown"}` +
            ` visible=${observation.visibleStreamCount ?? "unknown"}` +
            ` native=${observation.nativeStreamCount ?? "unknown"}` +
            ` voice_state=${observation.voiceState ?? "unknown"}` +
            ` voice_host=${observation.voiceHostname ?? "unknown"}` +
            ` selected_region=${observation.selectedRegion ?? "automatic"}`
        );
    }

    const nativeStreamCount = nativeKeys.known ? collectionCount(nativeKeys.value) : null;
    const decision = evaluateStreamClaim({
        now, senderClaimed, nativeStreamCount
    }, streamClaimState);

    streamClaimState = decision.state;
    const previousStatus = streamClaimStatus;
    streamClaimStatus = decision.status;

    if (decision.warn) {
        record("stream.guard | UI afirma transmissao, mas nenhuma conexao nativa apareceu em 30s; possivel erro 2001, sem acao automatica");
        showToast(
            "GoLiveBypass: Discord says you're streaming, but no native Live connection appeared (possible error 2001). Stop the false Live, reload with Ctrl+R, then start it again.",
            Toasts.Type.FAILURE
        );
    } else if (previousStatus.startsWith("failed") && decision.status === "healthy") {
        record("stream.guard | conexao nativa apareceu depois do aviso; estado recuperado");
    }
}

function pollStreamClaim() {
    try {
        pollStreamClaimOnce();
        streamClaimProbeFailed = false;
    } catch (error) {
        // Watchdog e diagnostico: uma mudanca de store nunca pode derrubar o
        // renderer. Registra uma vez e continua tentando nos proximos ciclos.
        if (!streamClaimProbeFailed)
            logger.error("Failed to inspect the native stream state", error);
        streamClaimProbeFailed = true;
    }
}

function startStreamClaimWatch() {
    if (streamClaimTimer !== null) return;
    streamClaimState = initialStreamClaimState();
    streamClaimStatus = "idle";
    streamClaimProbeFailed = false;
    lastStreamObservationKey = null;
    lastStreamObservation = null;
    lastSelectedStreamRegion = null;
    pollStreamClaim();
    streamClaimTimer = setInterval(pollStreamClaim, 5_000);
}

function stopStreamClaimWatch() {
    if (streamClaimTimer !== null) clearInterval(streamClaimTimer);
    streamClaimTimer = null;
    streamClaimState = initialStreamClaimState();
    streamClaimStatus = "idle";
    streamClaimProbeFailed = false;
    lastStreamObservationKey = null;
    lastStreamObservation = null;
    lastSelectedStreamRegion = null;
}

async function buildReport() {
    const user = UserStore.getCurrentUser();
    const lines: string[] = ["GoLiveBypass, diagnostico"];

    lines.push("", "== o servidor te bloqueia? ==");
    lines.push(`atribuicao do video guard: ${JSON.stringify(user == null ? "sem usuario" : ask(ApexExperimentStore, "getServerAssignment", "user", user.id, VIDEO_GUARD))}`);

    lines.push("", "== o cliente consegue fazer video? ==");
    lines.push(`supports(VIDEO)          ${ask(MediaEngineStore, "supports", "VIDEO")}`);
    lines.push(`supportsInApp(VIDEO)     ${ask(MediaEngineStore, "supportsInApp", "VIDEO")}`);
    lines.push(`supportsInApp(DESKTOP)   ${ask(MediaEngineStore, "supportsInApp", "DESKTOP_CAPTURE")}`);
    lines.push(`motor de midia pronto    ${ask(MediaEngineStore, "isSupported")}`);

    lines.push("", "== transmissao ==");
    const observation = lastStreamObservation;
    lines.push(`observacao stream        ${observation
        ? `${observation.status} | visiveis ${observation.visibleStreamCount ?? "desconhecido"} | nativas ${observation.nativeStreamCount ?? "desconhecido"}`
        : "sem amostra"}`);
    lines.push(`estado da call           ${ask(RTCConnectionStore, "getState")} em ${ask(RTCConnectionStore, "getHostname")}`);
    lines.push(`guarda UI/conexao nativa ${streamClaimStatus}`);

    lines.push("", "== regiao ==");
    lines.push(`preferida  ${ask(RTCRegionStore, "getPreferredRegion")}`);
    lines.push(`lista      ${JSON.stringify(ask(RTCRegionStore, "getPreferredRegions"))}`);
    lines.push(`override instalado ${original !== undefined}`);

    lines.push("", "== configuracao ==");
    const { vpnMode, customConfigPath, protonUsername, protonCountry, protonFreeOnly, protonAutoPing, voiceRegion, streamRegion } = settings.store;
    lines.push(`VPN "${vpnMode}" | conf personalizada "${customConfigPath ? "definida" : "vazia"}" | usuário Proton "${protonUsername ? "definido" : "vazio"}" | países "${protonCountry}" | somente grátis ${protonFreeOnly} | auto-ping ${protonAutoPing} | região de call "${voiceRegion}" | região de stream "${streamRegion}"`);

    lines.push("", "== processo principal ==");
    if (!Native) {
        lines.push("indisponivel, o plugin esta rodando sem a parte desktop");
    } else {
        try {
            const status = await Native.getVpnStatus();
            lines.push(`VPN agora: ${status.state} | ativa ${status.active} | ownership ${status.owned} | geração ${status.generation}`);
            if (status.externalReason) lines.push(`motivo externo: ${status.externalReason}`);
            if (status.lastDiagnostic) lines.push(`último diagnóstico: ${status.lastDiagnostic.kind} | ok ${status.lastDiagnostic.ok} | ${status.lastDiagnostic.detail}`);
            lines.push(await Native.getLog() || "sem registros");
        } catch (error) {
            lines.push(`nao consegui falar com o processo principal: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return lines.join("\n");
}

export default definePlugin({
    name: "GoLiveBypass",
    description: "Turns Go Live and camera back on for Brazilian accounts, and provides an isolated WireGuard VPN for this Discord only.",
    authors: [{ name: "bezumiya", id: 1366453661970071633n }],
    tags: ["Voice", "Privacy"],
    settings,
    settingsAboutComponent: AboutPlugin,
    toolboxActions: {
        "Abrir assistente do GoLiveBypass": openPluginOnboarding,
    },

    patches: [
        {
            find: "\"2026-08-video-guard\"",
            replacement: {
                match: /(?<=name:"2026-08-video-guard".{0,100}?)variations:\{.{0,120}?\}\}(?=\}\))/,
                replace: "variations:{}"
            }
        },
        {
            find: ".STREAM_CREATE,{type:",
            replacement: {
                match: /(?<=\.STREAM_CREATE,\{.{0,80}?preferred_region:)\i/,
                replace: "$self.pickStreamRegion($&)"
            }
        }
    ],

    pickStreamRegion(fallback: string | null) {
        const region = settings.store.streamRegion;
        const selected = typeof region === "string" && region !== AUTOMATIC ? region : fallback;
        lastSelectedStreamRegion = observationText(selected);
        return selected;
    },

    commands: [
        {
            name: "golivebypass",
            description: "Copia um diagnostico do plugin para voce colar no suporte.",
            async execute(_args, ctx) {
                const report = await buildReport();
                copyWithToast(report, "Diagnostico copiado. Cole no canal de suporte.");
                sendBotMessage(ctx.channel.id, { content: `\`\`\`\n${report.slice(0, 1800)}\n\`\`\`` });
            }
        }
    ],

    flux: {
        CONNECTION_OPEN() {
            reportSession();
        },

        LOGOUT() {
            record("voce saiu da conta; a VPN do plugin permanece isolada e nao troca a rota automaticamente");
        }
    },

    start() {
        forceRegion();
        startStreamClaimWatch();

        if (onboardingTimer !== null) clearTimeout(onboardingTimer);
        if (Native && settings.store.onboardingCompleted !== true) {
            onboardingTimer = setTimeout(() => {
                onboardingTimer = null;
                if (settings.store.onboardingCompleted !== true) openPluginOnboarding();
            }, 2_500);
        }

        const configure = Native?.configurePluginUpdates;
        if (typeof configure === "function") {
            void configure({
                enabled: settings.store.autoUpdate !== false,
                channel: normalizedUpdateChannel(settings.store.updateChannel)
            }).catch(error => logger.error("Falha ao configurar o updater do plugin", error));
        }

        // O aviso aparece mesmo para quem nunca abre a aba de configuração. O processo
        // principal faz a checagem/download; o renderer só observa se há reload pendente.
        if (updateCheckTimer !== null) clearTimeout(updateCheckTimer);
        updateCheckTimer = setTimeout(() => {
            updateCheckTimer = null;
            const getStatus = Native?.getPluginUpdateStatus;
            if (typeof getStatus !== "function") return;
            getStatus().then(status => {
                if (status.pending) notifyPendingPluginUpdate(status.pendingVersion);
            }).catch(error => logger.error("Falha ao consultar atualização pendente do plugin", error));
        }, 8_000);

        Native?.enable().then(result => {
            if (result?.success === false)
                showToast(`GoLiveBypass não conseguiu ativar a VPN: ${result.error || result.message || "veja o log"}`, Toasts.Type.FAILURE);
        }).catch(error => logger.error("Failed to reach the desktop process", error));
    },

    stop() {
        if (onboardingTimer !== null) {
            clearTimeout(onboardingTimer);
            onboardingTimer = null;
        }
        if (updateCheckTimer !== null) {
            clearTimeout(updateCheckTimer);
            updateCheckTimer = null;
        }
        stopStreamClaimWatch();
        restoreRegion();
        Native?.shutdown().catch(error => logger.error("Failed to reach the desktop process", error));
    }
});
