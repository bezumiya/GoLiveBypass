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
import { Button, closeModal as closeDiscordModal, Constants, MaskedLink, Modal, openModal, React, RestAPI, SearchableSelect, showToast, TextInput, Toasts, useEffect, UserStore, useState } from "@webpack/common";

import {
    evaluateStreamClaim,
    evaluateStreamObservation,
    initialStreamClaimState,
    normalizeStreamClaim,
    type StreamClaimState,
    type StreamObservation,
    type StreamObservationStatus,
} from "./stability";
import { protonUsernamesMatch, type VpnPlatform, type VpnState } from "./vpn-types";

type PluginUpdateChannel = "stable" | "beta";

interface PluginUpdateStatus {
    current: string;
    channel: PluginUpdateChannel;
    enabled: boolean;
    pending: boolean;
    pendingVersion?: string;
    pendingChannel?: PluginUpdateChannel;
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
    pendingChannel?: PluginUpdateChannel;
    error?: string;
}

interface PluginUpdateResult {
    ok: boolean;
    updated: boolean;
    current?: string;
    latest?: string;
    channel?: PluginUpdateChannel;
    pending?: boolean;
    pendingChannel?: PluginUpdateChannel;
    reloadRequired?: boolean;
    error?: string;
}

interface PluginUpdateNative {
    configurePluginUpdates?: (input: unknown) => Promise<{ enabled: boolean; channel: PluginUpdateChannel }>;
    getPluginUpdateStatus?: () => Promise<PluginUpdateStatus>;
    restartDiscord?: () => Promise<{ success: boolean; error?: string }>;
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

const PLUGIN_VERSION = "2.0.6-beta-10";
const PLUGIN_UPDATE_STATUS_POLL_INTERVAL_MS = 15_000;
const PLUGIN_UPDATE_STATUS_TIMEOUT_MS = 10_000;
const PLUGIN_UPDATE_CHECK_TIMEOUT_MS = 2 * 60_000 + 15_000;
const PLUGIN_UPDATE_INSTALL_TIMEOUT_MS = 3 * 60_000;
const CUSTOM_WIREGUARD_VALIDATION_TIMEOUT_MS = 30_000;
const PLUGIN_UPDATE_DEFER_MS = 6 * 60 * 60 * 1_000;

const AUTOMATIC = "";
const VOICE_KEYS: "voiceRegion"[] = ["voiceRegion"];
const STREAM_KEYS: "streamRegion"[] = ["streamRegion"];

let original: RegionStore | undefined;
let streamClaimTimer: ReturnType<typeof setInterval> | null = null;
let updateCheckTimer: ReturnType<typeof setTimeout> | null = null;
let lastNotifiedPendingVersion: string | null = null;
let lastNotifiedUpdateErrorKey: string | null = null;
let lastSuppressedUpdateErrorKey: string | null = null;
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
let onboardingOpen = false;
let onboardingModalKey: string | null = null;
let onboardingModalToken = 0;
let pluginLifecycleGeneration = 0;
let pluginUpdateStatusFlight: Promise<PluginUpdateStatus> | null = null;
const pluginUpdateOverlayDismissers = new Set<() => void>();

function normalizedUpdateChannel(value: unknown): PluginUpdateChannel {
    return value === "beta" ? "beta" : "stable";
}

function pluginUpdateStatusMatchesPolicy(status: PluginUpdateStatus, policy: { enabled: boolean; channel: PluginUpdateChannel }): boolean {
    return status.enabled === policy.enabled && status.channel === policy.channel;
}

function pluginUpdateStatusMatchesRendererPolicy(status: PluginUpdateStatus): boolean {
    return pluginUpdateStatusMatchesPolicy(status, {
        enabled: settings.store.autoUpdate !== false,
        channel: normalizedUpdateChannel(settings.store.updateChannel),
    });
}

function withTimeout<T>(operation: () => Promise<T> | T, timeoutMs: number, timeoutMessage: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(timeoutMessage));
        }, timeoutMs);
        const resolveOnce = (value: T) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const rejectOnce = (error: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        };
        Promise.resolve().then(operation).then(resolveOnce, rejectOnce);
    });
}

function readPluginUpdateStatus(): Promise<PluginUpdateStatus> | null {
    const getStatus = Native?.getPluginUpdateStatus;
    if (typeof getStatus !== "function") return null;
    if (pluginUpdateStatusFlight) return pluginUpdateStatusFlight;

    const flight = withTimeout(
        () => getStatus(),
        PLUGIN_UPDATE_STATUS_TIMEOUT_MS,
        "A consulta do estado do updater excedeu o tempo limite.",
    );
    pluginUpdateStatusFlight = flight;
    void flight.finally(() => {
        if (pluginUpdateStatusFlight === flight) pluginUpdateStatusFlight = null;
    }).catch(() => undefined);
    return flight;
}

function dismissPluginUpdateOverlays(): void {
    for (const dismiss of pluginUpdateOverlayDismissers) dismiss();
}

function dismissPluginUpdateToast(version: string): void {
    // Permite que o polling do painel mostre novamente a mesma versão quando o
    // adiamento expirar; enquanto isso, updateDeferredUntil faz a supressão.
    lastNotifiedPendingVersion = null;
    settings.store.updateDeferredVersion = version;
    settings.store.updateDeferredUntil = String(Date.now() + PLUGIN_UPDATE_DEFER_MS);
}

function reloadForPreparedPluginUpdate(): void {
    const restart = Native?.restartDiscord;
    if (typeof restart !== "function") {
        showToast("Reinicie o Discord manualmente para aplicar a atualização do GoLiveBypass.", Toasts.Type.FAILURE);
        return;
    }
    void restart().then(result => {
        if (result?.success === false) {
            showToast(`GoLiveBypass não conseguiu reiniciar o Discord: ${result.error || "veja o log"}`, Toasts.Type.FAILURE);
        }
    }).catch(error => {
        showToast(`GoLiveBypass não conseguiu reiniciar o Discord: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
    });
}

function PluginUpdateToast({ currentVersion, availableVersion, channel, lifecycleGeneration }: { currentVersion: string; availableVersion: string; channel: PluginUpdateChannel; lifecycleGeneration: number }) {
    const [dismissed, setDismissed] = useState(false);
    const dismiss = React.useCallback(() => setDismissed(true), []);

    useEffect(() => {
        pluginUpdateOverlayDismissers.add(dismiss);
        return () => { pluginUpdateOverlayDismissers.delete(dismiss); };
    }, [dismiss]);

    if (dismissed || lifecycleGeneration !== pluginLifecycleGeneration) return null;

    return (
        <div
            role="status"
            aria-live="polite"
            onClick={event => event.stopPropagation()}
            style={{
                width: "min(360px, calc(100vw - 32px))",
                padding: "16px",
                borderRadius: "8px",
                background: "var(--background-floating)",
                border: "1px solid var(--background-modifier-accent)",
                boxShadow: "var(--elevation-high)",
            }}
        >
            <Paragraph><strong>Atualização do GoLiveBypass pronta</strong></Paragraph>
            <Paragraph>Atual: v{currentVersion} · disponível: v{availableVersion} · Canal: {channel}</Paragraph>
            <Paragraph>A versão disponível foi baixada, verificada e preparada. O Discord não será reiniciado sozinho.</Paragraph>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                <Button onClick={() => { dismiss(); dismissPluginUpdateToast(availableVersion); }}>Depois</Button>
                <Button onClick={() => { dismiss(); reloadForPreparedPluginUpdate(); }}>Recarregar Discord</Button>
            </div>
        </div>
    );
}

function PluginUpdateFailureToast({ currentVersion, channel, error, lifecycleGeneration }: { currentVersion: string; channel: PluginUpdateChannel; error: string; lifecycleGeneration: number }) {
    const [dismissed, setDismissed] = useState(false);
    const dismiss = React.useCallback(() => setDismissed(true), []);

    useEffect(() => {
        pluginUpdateOverlayDismissers.add(dismiss);
        return () => { pluginUpdateOverlayDismissers.delete(dismiss); };
    }, [dismiss]);

    if (dismissed || lifecycleGeneration !== pluginLifecycleGeneration) return null;

    return (
        <div
            role="status"
            aria-live="polite"
            onClick={event => event.stopPropagation()}
            style={{
                width: "min(360px, calc(100vw - 32px))",
                padding: "16px",
                borderRadius: "8px",
                background: "var(--background-floating)",
                border: "1px solid var(--status-danger)",
                boxShadow: "var(--elevation-high)",
            }}
        >
            <Paragraph><strong>Falha ao atualizar o GoLiveBypass</strong></Paragraph>
            <Paragraph>Atual: v{currentVersion} · Canal: {channel}</Paragraph>
            <Paragraph>{error.slice(0, 240)}</Paragraph>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Button onClick={dismiss}>Depois</Button>
            </div>
        </div>
    );
}

interface PluginUpdateErrorContext {
    key: string;
    currentVersion: string;
    channel: PluginUpdateChannel;
    detail: string;
}

function pluginUpdateErrorContext(current: unknown, channel: unknown, error: unknown): PluginUpdateErrorContext | null {
    if (typeof error !== "string" || !error.trim()) return null;
    const currentVersion = typeof current === "string" && current ? current : PLUGIN_VERSION;
    const normalizedChannel = normalizedUpdateChannel(channel);
    const detail = error.trim().slice(0, 240);
    return { key: `${normalizedChannel}:${currentVersion}:${detail}`, currentVersion, channel: normalizedChannel, detail };
}

function suppressPluginUpdateFailure(current: unknown, channel: unknown, error: unknown): void {
    const context = pluginUpdateErrorContext(current, channel, error);
    if (context) lastSuppressedUpdateErrorKey = context.key;
}

function notifyPluginUpdateFailure(current: unknown, channel: unknown, error: unknown): void {
    const context = pluginUpdateErrorContext(current, channel, error);
    if (!context) return;
    if (context.key === lastSuppressedUpdateErrorKey) {
        lastSuppressedUpdateErrorKey = null;
        return;
    }
    lastSuppressedUpdateErrorKey = null;
    if (context.key === lastNotifiedUpdateErrorKey) return;
    lastNotifiedUpdateErrorKey = context.key;
    showToast("Atualização do GoLiveBypass", Toasts.Type.CUSTOM, {
        position: Toasts.Position.BOTTOM,
        duration: 15_000,
        component: <PluginUpdateFailureToast currentVersion={context.currentVersion} channel={context.channel} error={context.detail} lifecycleGeneration={pluginLifecycleGeneration} />,
    });
}

function notifyPendingPluginUpdate(current: unknown, version: unknown, channel: unknown): void {
    if (typeof version !== "string" || !version || version === lastNotifiedPendingVersion) return;
    const currentVersion = typeof current === "string" && current ? current : PLUGIN_VERSION;
    const normalizedChannel = normalizedUpdateChannel(channel);
    const deferredVersion = settings.store.updateDeferredVersion;
    const deferredUntil = Number(settings.store.updateDeferredUntil);
    if (deferredVersion === version && Number.isFinite(deferredUntil) && deferredUntil > Date.now()) return;
    lastNotifiedPendingVersion = version;
    showToast("Atualização do GoLiveBypass", Toasts.Type.CUSTOM, {
        position: Toasts.Position.BOTTOM,
        duration: 15_000,
        component: <PluginUpdateToast currentVersion={currentVersion} availableVersion={version} channel={normalizedChannel} lifecycleGeneration={pluginLifecycleGeneration} />,
    });
}

function schedulePluginUpdateStatusObservation(lifecycleGeneration: number): void {
    if (updateCheckTimer !== null) clearTimeout(updateCheckTimer);

    const observe = () => {
        updateCheckTimer = null;
        if (lifecycleGeneration !== pluginLifecycleGeneration) return;
        const scheduleNext = () => {
            if (lifecycleGeneration !== pluginLifecycleGeneration) return;
            updateCheckTimer = setTimeout(observe, PLUGIN_UPDATE_STATUS_POLL_INTERVAL_MS);
        };
        const statusRequest = readPluginUpdateStatus();
        if (!statusRequest) {
            scheduleNext();
            return;
        }
        statusRequest.then(status => {
            if (lifecycleGeneration !== pluginLifecycleGeneration) return;
            if (!pluginUpdateStatusMatchesRendererPolicy(status)) return;
            if (status.lastError) notifyPluginUpdateFailure(status.current, status.channel, status.lastError);
            else {
                lastNotifiedUpdateErrorKey = null;
                lastSuppressedUpdateErrorKey = null;
            }
            if (status.pending) notifyPendingPluginUpdate(status.current, status.pendingVersion, status.pendingChannel || status.channel);
        }).catch(error => {
            if (lifecycleGeneration === pluginLifecycleGeneration) logger.error("Falha ao consultar atualização pendente do plugin", error);
        }).finally(scheduleNext);
    };

    updateCheckTimer = setTimeout(observe, 8_000);
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
    code?: "INVALID_SESSION" | "NETWORK_ERROR" | "TIMEOUT" | "MISSING_EXECUTABLE" | "SESSION_PERSISTENCE" | "UNKNOWN";
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

function protonSessionStatusTitle(code: ProtonSessionCheck["code"]): string {
    switch (code) {
        case "NETWORK_ERROR":
        case "TIMEOUT":
            return "Rede indisponível para verificar a sessão";
        case "MISSING_EXECUTABLE":
            return "Componente ProtonVPN ausente";
        case "SESSION_PERSISTENCE":
            return "Armazenamento da sessão indisponível";
        case "INVALID_SESSION":
            return "Sessão precisa ser renovada";
        default:
            return "Não foi possível verificar a sessão";
    }
}

type OnboardingPage = "account" | "route" | "ready";

const onboardingBoxStyle = {
    background: "var(--background-secondary-alt)",
    border: "1px solid var(--background-modifier-accent)",
    borderRadius: "8px",
    padding: "16px",
};

function OnboardingSteps({ page, customMode }: { page: OnboardingPage; customMode: boolean }) {
    const active = page === "account" ? 0 : page === "route" ? 1 : 2;
    const labels = customMode
        ? ["1  Configuração WireGuard", "2  Rota real", "3  Pronto"]
        : ["1  Conta Proton", "2  Rota real", "3  Pronto"];
    return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "16px" }} aria-label="Etapas da configuração" role="list">
            {labels.map((label, index) => (
                <div
                    key={label}
                    role="listitem"
                    aria-current={index === active ? "step" : undefined}
                    style={{
                        flex: "1 1 120px",
                        minWidth: 0,
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

function PluginOnboardingModal({ modalProps, onClosed }: { modalProps: RenderModalProps; onClosed: () => void }) {
    const customMode = settings.store.vpnMode === "custom";
    const requiredOnOpen = Boolean(Native && settings.store.onboardingCompleted !== true);
    const [page, setPage] = useState<OnboardingPage>("account");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [twoFactorCode, setTwoFactorCode] = useState("");
    const [session, setSession] = useState<ProtonSessionCheck | null>(null);
    const [sessionLoading, setSessionLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [customConfigPath, setCustomConfigPath] = useState(
        typeof settings.store.customConfigPath === "string" ? settings.store.customConfigPath : ""
    );
    const [vpnStatus, setVpnStatus] = useState<PluginVpnStatus | null>(null);
    const [optimization, setOptimization] = useState<PluginOptimizationStatus | null>(null);
    const [requestId, setRequestId] = useState<string | null>(null);
    const disposedRef = React.useRef(false);
    const accountRevisionRef = React.useRef(0);
    const sessionCheckRef = React.useRef(0);
    const closedRef = React.useRef(false);
    const pageHeadingRef = React.useRef<HTMLHeadingElement | null>(null);
    const loginRequestIdRef = React.useRef<string | null>(null);
    const optimizationRequestRef = React.useRef<string | null>(null);
    const optimizationAttemptRef = React.useRef(0);
    const optimizationStatusRequestRef = React.useRef(0);
    const requireFreshOptimizationRef = React.useRef(false);
    const [loginCancelRequested, setLoginCancelRequested] = useState(false);

    const cancelActiveOptimization = () => {
        optimizationAttemptRef.current++;
        optimizationStatusRequestRef.current++;
        const activeRequestId = optimizationRequestRef.current;
        optimizationRequestRef.current = null;
        if (!activeRequestId || typeof Native?.cancelProtonOptimization !== "function") return;
        void Promise.resolve(Native.cancelProtonOptimization(activeRequestId)).catch(error => logger.error("Falha ao cancelar otimização ao fechar o assistente", error));
    };

    const cancelActiveLogin = () => {
        const activeRequestId = loginRequestIdRef.current;
        if (!activeRequestId || typeof Native?.cancelProtonLogin !== "function") return;
        loginRequestIdRef.current = null;
        accountRevisionRef.current++;
        sessionCheckRef.current++;
        setPassword("");
        setTwoFactorCode("");
        if (!disposedRef.current) {
            setLoginCancelRequested(true);
            setError("Cancelando o login Proton…");
        }
        void Promise.resolve(Native.cancelProtonLogin(activeRequestId)).catch(error => logger.error("Falha ao cancelar login Proton", error));
    };

    useEffect(() => {
        disposedRef.current = false;
        return () => {
            disposedRef.current = true;
            accountRevisionRef.current++;
            sessionCheckRef.current++;
            cancelActiveLogin();
            cancelActiveOptimization();
            onClosed();
        };
    }, []);
    useEffect(() => {
        let active = true;
        if (typeof Native?.getVpnStatus === "function") {
            void Promise.resolve(Native.getVpnStatus()).then(status => {
                if (active && !disposedRef.current && status) setVpnStatus(status as PluginVpnStatus);
            }).catch(() => {});
        }
        return () => { active = false; };
    }, []);

    useEffect(() => {
        if (!disposedRef.current) {
            const timer = setTimeout(() => {
                if (!disposedRef.current) pageHeadingRef.current?.focus({ preventScroll: true });
            }, 50);
            return () => clearTimeout(timer);
        }
    }, [page]);

    const closeModal = () => {
        if (closedRef.current) return;
        if (requiredOnOpen && settings.store.onboardingCompleted !== true && page !== "ready") return;
        closedRef.current = true;
        if (page === "account" && busy) cancelActiveLogin();
        if (page === "route" && busy) cancelActiveOptimization();
        disposedRef.current = true;
        accountRevisionRef.current++;
        sessionCheckRef.current++;
        onClosed();
        modalProps.onClose();
    };

    const complete = () => {
        settings.store.onboardingCompleted = true;
        closeModal();
        if (typeof Native?.enable !== "function") return;
        // Concluir a configuração precisa deixar o Discord já roteado: o túnel
        // sobe aqui e o cliente reinicia para a rota valer sem um passo manual
        // no painel. "Voltar" continua disponível para quem quiser reconfigurar.
        void Promise.resolve(Native.enable()).then(result => {
            if (result && result.success === false) {
                showToast(
                    `GoLiveBypass não conseguiu ativar a VPN: ${result.error || result.message || "veja o log"}`,
                    Toasts.Type.FAILURE
                );
            }
        }).catch(activationError => {
            logger.error("Falha ao ativar a VPN após concluir a configuração", activationError);
        });
    };

    const checkSession = async (value: string) => {
        if (!Native || !value.trim()) {
            if (!disposedRef.current) setSession({ valid: false, code: "INVALID_SESSION", error: "Informe o usuário Proton." });
            return null;
        }
        const revision = accountRevisionRef.current;
        const request = ++sessionCheckRef.current;
        const isCurrent = () => !disposedRef.current
            && revision === accountRevisionRef.current
            && request === sessionCheckRef.current;
        setSessionLoading(true);
        try {
            const result = await Native.checkProtonSession(value.trim()) as ProtonSessionCheck;
            if (!isCurrent()) return null;
            setSession(result);
            return result;
        } catch {
            if (!isCurrent()) return null;
            const result: ProtonSessionCheck = {
                valid: false,
                code: "NETWORK_ERROR",
                error: "Não foi possível verificar a sessão Proton por causa da rede.",
            };
            setSession(result);
            return result;
        } finally {
            if (isCurrent()) setSessionLoading(false);
        }
    };

    useEffect(() => {
        let disposed = false;
        const loadRevision = accountRevisionRef.current;
        const load = async () => {
            if (!Native) {
                if (!disposed) setSessionLoading(false);
                return;
            }
            if (customMode) {
                if (!disposed && !disposedRef.current) {
                    setSession(null);
                    setSessionLoading(false);
                }
                return;
            }
            try {
                const saved = await Native.getProtonSettings();
                const record = saved as { protonUsername?: unknown; sessionUsername?: unknown };
                const savedUsername = typeof record.sessionUsername === "string" && record.sessionUsername.trim()
                    ? record.sessionUsername.trim()
                    : typeof record.protonUsername === "string" ? record.protonUsername.trim() : "";
                if (disposed || disposedRef.current || loadRevision !== accountRevisionRef.current) return;
                if (savedUsername) {
                    setUsername(savedUsername);
                    const result = await checkSession(savedUsername);
                    if (!disposed && !disposedRef.current && result?.valid) {
                        setError(null);
                        // A sessão salva já vale: pedir email e senha de novo é
                        // atrito puro. Vai direto para a rota, que é o passo que
                        // falta; "Voltar" reabre a conta para quem quiser trocar.
                        enterRoute();
                    }
                } else {
                    setSessionLoading(false);
                }
            } catch (loadError) {
                if (!disposed && !disposedRef.current && loadRevision === accountRevisionRef.current) {
                    setSessionLoading(false);
                    setError(loadError instanceof Error ? loadError.message : "Não foi possível ler a sessão Proton.");
                }
            }
        };
        void load();
        return () => {
            disposed = true;
        };
    }, [customMode]);

    useEffect(() => {
        if (page !== "route" || customMode || !Native) return;
        let disposed = false;
        const refresh = async () => {
            const request = ++optimizationStatusRequestRef.current;
            try {
                const next = await Native.getProtonOptimizationStatus() as PluginOptimizationStatus;
                const currentRequestId = optimizationRequestRef.current;
                const belongsToCurrentAttempt = typeof currentRequestId === "string"
                    && currentRequestId.length > 0
                    && next.requestId === currentRequestId;
                if (!disposed && !disposedRef.current && request === optimizationStatusRequestRef.current
                    && !requireFreshOptimizationRef.current && belongsToCurrentAttempt) setOptimization(next);
            } catch (statusError) {
                if (!disposed && !disposedRef.current) logger.error("Falha ao ler progresso da otimização Proton", statusError);
            }
        };
        void refresh();
        const timer = setInterval(() => void refresh(), 750);
        return () => {
            disposed = true;
            optimizationStatusRequestRef.current++;
            clearInterval(timer);
        };
    }, [page, customMode]);

    const enterRoute = () => {
        // O status nativo é global e pode refletir uma otimização anterior feita
        // no painel da VPN. A página só deve aceitar dados da tentativa criada
        // por este assistente.
        requireFreshOptimizationRef.current = true;
        optimizationRequestRef.current = null;
        optimizationStatusRequestRef.current++;
        setRequestId(null);
        setOptimization(null);
        setPage("route");
    };
    const selectCustomConfig = async () => {
        if (!Native || busy || typeof Native.selectWireGuardConfig !== "function") return;
        setBusy(true);
        setError(null);
        try {
            const result = await Native.selectWireGuardConfig() as {
                success?: boolean;
                cancelled?: boolean;
                path?: string;
                error?: string;
            };
            if (disposedRef.current || result.cancelled) return;
            if (result.success !== true || typeof result.path !== "string" || !result.path) {
                throw new Error(result.error || "Não foi possível importar a configuração WireGuard.");
            }
            settings.store.customConfigPath = result.path;
            setCustomConfigPath(result.path);
        } catch (selectError) {
            if (!disposedRef.current) {
                setError(selectError instanceof Error ? selectError.message : "Não foi possível importar a configuração WireGuard.");
            }
        } finally {
            if (!disposedRef.current) setBusy(false);
        }
    };


    const continueToRoute = async () => {
        if (!Native || busy || sessionLoading || (!customMode && !username.trim())) return;
        const revision = accountRevisionRef.current;
        setError(null);
        setBusy(true);
        try {
            if (customMode) {
                setSession(null);
                enterRoute();
                return;
            }
            let verified = session?.valid && typeof session.username === "string" && protonUsernamesMatch(session.username, username) ? session : null;
            if (!verified) {
                if (!password) {
                    // Sem senha não há o que tentar. O motivo pelo qual a sessão
                    // guardada não serve entra na mensagem, sem chamá-la de
                    // expirada: pode ser armazenamento local, rede ou helper.
                    const detail = session && !session.valid && session.code && session.code !== "INVALID_SESSION"
                        ? (session.error || protonSessionStatusTitle(session.code))
                        : null;
                    setError(detail
                        ? `${detail} Informe a senha para entrar novamente.`
                        : "Informe a senha para iniciar uma nova sessão ou renovar a sessão atual.");
                    return;
                }
                const loginRequestId = `plugin-onboarding-login-${Date.now()}-${Math.random().toString(16).slice(2)}`;
                loginRequestIdRef.current = loginRequestId;
                setLoginCancelRequested(false);
                const loginResult = await Native.loginProton({ username: username.trim(), password, twoFactorCode, requestId: loginRequestId });
                if (loginRequestIdRef.current === loginRequestId) loginRequestIdRef.current = null;
                if (disposedRef.current || revision !== accountRevisionRef.current) return;
                if (!loginResult.success) {
                    const { code } = loginResult;
                    if (code === "CANCELLED") setError("Login Proton cancelado. Você pode tentar novamente.");
                    else if (code === "TWO_FACTOR_REQUIRED") setError("Esta conta exige o código 2FA.");
                    else if (code === "NETWORK_ERROR" || code === "TIMEOUT") setError("O login não conseguiu alcançar o Proton. Verifique a rede e tente novamente.");
                    else setError(loginResult.error || loginResult.message || "Não foi possível entrar no Proton.");
                    return;
                }
                setPassword("");
                setTwoFactorCode("");
                const checked = await checkSession(username);
                if (disposedRef.current || revision !== accountRevisionRef.current) return;
                if (!checked) return;
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
            if (disposedRef.current || revision !== accountRevisionRef.current) return;
            setSession(verified);
            enterRoute();
        } catch (continueError) {
            if (!disposedRef.current && revision === accountRevisionRef.current) {
                setError(continueError instanceof Error ? continueError.message : "Não foi possível concluir a etapa da conta Proton.");
            }
        } finally {
            loginRequestIdRef.current = null;
            if (!disposedRef.current) setLoginCancelRequested(false);
            if (!disposedRef.current) setBusy(false);
        }
    };

    const optimizeRoute = async () => {
        if (!Native || busy) return;
        const nextRequestId = `plugin-onboarding-${Date.now()}`;
        const attempt = ++optimizationAttemptRef.current;
        const isOptimizationCurrent = () => !disposedRef.current && attempt === optimizationAttemptRef.current;
        optimizationStatusRequestRef.current++;
        requireFreshOptimizationRef.current = false;
        optimizationRequestRef.current = customMode ? null : nextRequestId;
        setRequestId(nextRequestId);
        setOptimization({
            active: true,
            requestId: nextRequestId,
            phase: "preparing",
            total: 0,
            tested: 0,
            succeeded: 0,
            updatedAt: Date.now(),
        });
        setBusy(true);
        setError(null);
        try {
            if (customMode) {
                const result = await withTimeout(
                    () => Native.testWireGuardConfig(customConfigPath) as Promise<{ success?: boolean; error?: string }>,
                    CUSTOM_WIREGUARD_VALIDATION_TIMEOUT_MS,
                    "A validação da configuração WireGuard excedeu o tempo limite. Cancele e tente novamente.",
                );
                if (!isOptimizationCurrent()) return;
                if (result.success !== true) throw new Error(result.error || "A configuração WireGuard personalizada não passou na validação.");
                setOptimization({
                    active: false,
                    requestId: nextRequestId,
                    phase: "completed",
                    total: 0,
                    tested: 0,
                    succeeded: 0,
                    updatedAt: Date.now(),
                });
                setPage("ready");
                return;
            }
            const result = await Native.optimizeProtonRoute({
                requestId: nextRequestId,
                speedTest: true,
                country: settings.store.protonCountry,
                freeOnly: settings.store.protonFreeOnly,
                autoPing: settings.store.protonAutoPing,
            });
            if (!isOptimizationCurrent()) return;
            if (!result.success && "cancelled" in result && result.cancelled) {
                setOptimization(current => current ? { ...current, active: false, phase: "cancelled", error: result.error, updatedAt: Date.now() } : {
                    active: false,
                    requestId: nextRequestId,
                    phase: "cancelled",
                    total: 0,
                    tested: 0,
                    succeeded: 0,
                    error: result.error,
                    updatedAt: Date.now(),
                });
                setError("Otimização cancelada. Você pode tentar novamente.");
                return;
            }
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
            if (isOptimizationCurrent()) {
                const detail = optimizeError instanceof Error ? optimizeError.message : "A otimização Proton falhou.";
                setOptimization(current => ({
                    active: false,
                    requestId: nextRequestId,
                    phase: "failed",
                    total: current?.total ?? 0,
                    tested: current?.tested ?? 0,
                    succeeded: current?.succeeded ?? 0,
                    server: current?.server,
                    pingMs: current?.pingMs,
                    downloadMbps: current?.downloadMbps,
                    uploadMbps: current?.uploadMbps,
                    error: detail,
                    updatedAt: Date.now(),
                }));
                setError(detail);
            }
        } finally {
            if (isOptimizationCurrent()) {
                optimizationRequestRef.current = null;
                setBusy(false);
            }
        }
    };

    const cancelOptimization = () => {
        if (!busy) return;
        cancelActiveOptimization();
        setRequestId(null);
        setOptimization(current => current ? {
            ...current,
            active: false,
            phase: "cancelled",
            error: customMode ? "Validação cancelada." : "Otimização cancelada.",
            updatedAt: Date.now(),
        } : null);
        setError(customMode ? "Validação cancelada. Você pode tentar novamente." : "Otimização cancelada. Você pode tentar novamente.");
        setBusy(false);
    };

    const progress = optimization;
    const progressPercent = progress && progress.total > 0
        ? Math.min(100, Math.round((progress.tested / progress.total) * 100))
        : null;
    const progressIsIndeterminate = progress?.active === true && progressPercent === null;
    const phaseLabel = customMode
        ? progress?.phase === "preparing" ? "validando configuração"
            : progress?.phase === "completed" ? "configuração validada"
            : progress?.phase === "failed" ? "validação falhou"
                : progress?.phase === "cancelled" ? "validação cancelada"
                    : "pronto para validar"
        : progress?.phase === "ping" ? "medindo latência"
            : progress?.phase === "testing" ? "testando servidores"
                : progress?.phase === "finalizing" ? "finalizando a configuração"
                    : progress?.phase === "completed" ? "rota preparada"
                        : progress?.phase === "failed" ? "otimização falhou"
                            : progress?.phase === "cancelled" ? "otimização cancelada"
                                : "preparando a seleção";

    const actions = page === "account" ? [
        { text: busy ? (customMode ? "Validando…" : "Entrando…") : customMode ? "Continuar para rota real" : "Continuar para rota real", variant: "primary" as const, onClick: () => void continueToRoute(), disabled: busy || sessionLoading || (!customMode && !username.trim()) },
        ...(busy && !customMode ? [{ text: loginCancelRequested ? "Cancelando…" : "Cancelar login", variant: "danger" as const, onClick: cancelActiveLogin, disabled: loginCancelRequested }] : []),
    ] : page === "route" ? [
        { text: "Voltar", variant: "secondary" as const, onClick: () => { if (!busy) setPage("account"); }, disabled: busy },
        busy
            ? { text: customMode ? "Cancelar validação" : "Cancelar otimização", variant: "danger" as const, onClick: cancelOptimization }
            : { text: progress?.phase === "completed" ? "Continuar" : customMode ? "Validar rota real" : "Preparar rota real", variant: "primary" as const, onClick: progress?.phase === "completed" ? () => setPage("ready") : () => void optimizeRoute() },
    ] : [
        { text: "Ativar VPN e reiniciar o Discord", variant: "primary" as const, onClick: complete },
    ];
    const pageHeading = page === "account"
        ? customMode ? "1. Configure sua rota WireGuard" : "1. Conecte sua conta ProtonVPN"
        : page === "route"
            ? customMode ? "2. Valide sua rota WireGuard real" : "2. Prepare e teste sua rota real"
            : customMode ? "3. Configuração concluída e validada" : "3. Rota real preparada e pronta";

    if (!Native) {
        return <Modal {...modalProps} onClose={closeModal} title="Configuração do GoLiveBypass" size="md" actions={[{ text: "Fechar", variant: "secondary", onClick: closeModal }]}>
            <Paragraph>A parte nativa do plugin não está disponível nesta instalação. O transporte WireGuard exige a ponte desktop nos clientes homologados (Windows x64 e Linux x64).</Paragraph>
        </Modal>;
    }

    return (
        <Modal {...modalProps} onClose={closeModal} title="Configurar o GoLiveBypass" size="md" actions={actions}>
            <div style={{ maxHeight: "min(60vh, 560px)", overflowY: "auto", overflowX: "hidden", paddingRight: "4px", minWidth: 0 }}>
                <OnboardingSteps page={page} customMode={customMode} />
                <h2 ref={pageHeadingRef} tabIndex={-1} style={{ margin: "0 0 12px", color: "var(--header-primary)" }}>{pageHeading}</h2>
                {page === "account" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    {customMode ? (
                        <>
                            <Paragraph>O modo personalizado não usa conta Proton nem solicita credenciais. Na etapa seguinte, o plugin validará a rota WireGuard real configurada antes de concluir.</Paragraph>
                            {vpnStatus?.platform === "unsupported" && (
                                <Paragraph role="alert" aria-live="polite">
                                    <strong>Plataforma não suportada:</strong> {vpnStatus.externalReason || "O transporte WireGuard exige Windows x64 ou Linux x64."}
                                </Paragraph>
                            )}
                            {Boolean(vpnStatus?.dependencies && vpnStatus.dependencies.length > 0) && (
                                <Paragraph role="alert" aria-live="polite">
                                    <strong>Dependências do sistema:</strong> Pacotes ausentes ({vpnStatus!.dependencies!.join(", ")}). Você pode validar o arquivo agora, mas a ativação exigirá a instalação dos pacotes necessários.
                                </Paragraph>
                            )}
                            <Button onClick={() => void selectCustomConfig()} disabled={busy || sessionLoading}>
                                {customConfigPath.trim() ? "Trocar arquivo .conf" : "Selecionar arquivo .conf"}
                            </Button>
                            <div style={onboardingBoxStyle} role="status" aria-live="polite" aria-busy={busy}>
                                <Paragraph>{customConfigPath.trim() ? "Arquivo WireGuard importado para a pasta privada do plugin." : "Nenhum arquivo WireGuard personalizado foi configurado ainda."}</Paragraph>
                            </div>
                            {error && <Paragraph role="alert" aria-live="assertive"><strong>{error}</strong></Paragraph>}
                        </>
                    ) : (
                        <>
                            <Paragraph>A sessão é validada e fica somente no armazenamento protegido do plugin. Senhas e códigos nunca são exibidos no diagnóstico.</Paragraph>
                            {vpnStatus?.sessionStorage === "memory-only" && (
                                <Paragraph role="note" aria-live="polite">
                                    <strong>Esta máquina não guarda a sessão:</strong> o armazenamento seguro do sistema (Secret Service/libsecret) não está disponível. Você entra normalmente, mas a sessão vale só enquanto o Discord estiver aberto e o login será pedido de novo depois de reiniciá-lo — nada é gravado em texto claro no disco.
                                </Paragraph>
                            )}
                            {vpnStatus?.platform === "unsupported" && (
                                <Paragraph role="alert" aria-live="polite">
                                    <strong>Plataforma não suportada:</strong> {vpnStatus.externalReason || "O transporte WireGuard exige Windows x64 ou Linux x64."}
                                </Paragraph>
                            )}
                            {Boolean(vpnStatus?.dependencies && vpnStatus.dependencies.length > 0) && (
                                <Paragraph role="alert" aria-live="polite">
                                    <strong>Dependências do sistema:</strong> Pacotes ausentes ({vpnStatus!.dependencies!.join(", ")}). Você pode preparar a rota agora, mas a ativação exigirá a instalação dos pacotes necessários.
                                </Paragraph>
                            )}
                            <TextInput value={username} onChange={value => {
                                if (!protonUsernamesMatch(value, username)) {
                                    accountRevisionRef.current++;
                                    sessionCheckRef.current++;
                                    setSession(null);
                                    setPassword("");
                                    setTwoFactorCode("");
                                    setOptimization(null);
                                    setRequestId(null);
                                    optimizationRequestRef.current = null;
                                    optimizationAttemptRef.current++;
                                    optimizationStatusRequestRef.current++;
                                    requireFreshOptimizationRef.current = true;
                                    setSessionLoading(false);
                                    setError(null);
                                }
                                setUsername(value);
                            }} placeholder="Usuário ProtonVPN" aria-label="Usuário ProtonVPN" disabled={busy} />
                            <TextInput value={password} onChange={setPassword} placeholder="Senha ProtonVPN" aria-label="Senha ProtonVPN" type="password" disabled={busy} />
                            <TextInput value={twoFactorCode} onChange={setTwoFactorCode} placeholder="Código 2FA (se solicitado)" aria-label="Código 2FA (se solicitado)" disabled={busy} />
                            {sessionLoading && <Paragraph>Verificando a sessão salva…</Paragraph>}
                            {!sessionLoading && session?.valid && <Paragraph><strong>Sessão válida</strong>{session.expiresIn ? ` · expira ${session.expiresIn}` : ""}. Você pode continuar sem digitar a senha.</Paragraph>}
                            {!sessionLoading && session && !session.valid && <Paragraph><strong>{protonSessionStatusTitle(session.code)}</strong>{session.error ? ` · ${session.error}` : ""}</Paragraph>}
                            {error && <Paragraph role="alert" aria-live="assertive"><strong>{error}</strong></Paragraph>}
                            {!!username.trim() && !sessionLoading && <Button onClick={() => void checkSession(username)} disabled={busy}>Verificar sessão novamente</Button>}
                        </>
                    )}
                    </div>
                )}
                {page === "route" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    <Paragraph>{customMode ? "O plugin vai validar a configuração WireGuard escolhida nas opções. O túnel WireGuard isola apenas o cliente Discord (via AllowedApps no Windows ou network namespace no Linux); probes de rede são diagnósticos de conectividade e não comprovam localização geográfica." : "O plugin vai selecionar uma configuração WireGuard e testar os servidores Proton elegíveis. O túnel WireGuard isola apenas o cliente Discord (via AllowedApps no Windows ou network namespace no Linux); probes de rede são diagnósticos de conectividade e não comprovam localização geográfica."}</Paragraph>
                    <div style={onboardingBoxStyle} role="status" aria-live="polite" aria-busy={busy}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}><strong>Estado da rota</strong><span>{phaseLabel}</span></div>
                        {(progressPercent !== null || progressIsIndeterminate) && <progress {...(progressPercent === null ? {} : { value: progressPercent })} max={100} aria-label="Progresso da validação da rota" aria-valuetext={progressPercent === null ? "Validação em andamento; total ainda não conhecido" : `${progressPercent}%`} style={{ width: "100%", marginTop: "12px" }} />}
                        {progress && progress.total > 0 && <Paragraph>{progress.tested} de {progress.total} servidores testados · {progress.succeeded} aprovados</Paragraph>}
                        {progress?.server && <Paragraph>Servidor selecionado: {progress.server}</Paragraph>}
                        {typeof progress?.pingMs === "number" && <Paragraph>Latência medida: {progress.pingMs} ms</Paragraph>}
                        {progress?.phase === "completed" && <Paragraph>{customMode ? "A rota WireGuard foi validada com sucesso. Clique em Continuar e, ao concluir, o plugin ativa o túnel e reinicia o Discord." : "A rota real foi selecionada e salva. Clique em Continuar e, ao concluir, o plugin ativa o túnel e reinicia o Discord."}</Paragraph>}
                    </div>
                    {error && <Paragraph role="alert" aria-live="assertive"><strong>{error}</strong></Paragraph>}
                    </div>
                )}
                {page === "ready" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    <div style={onboardingBoxStyle} role="status" aria-live="polite">
                        <Paragraph>{customMode ? "A configuração WireGuard personalizada passou na validação com sucesso. Ao concluir, o plugin ativa o túnel e reinicia o Discord para a rota já valer. Probes de rede são diagnósticos de conectividade e não comprovam localização geográfica." : "A rota Proton real foi preparada com sucesso. Ao concluir, o plugin ativa o túnel e reinicia o Discord para a rota já valer. Probes de rede são diagnósticos de conectividade e não comprovam localização geográfica."}</Paragraph>
                        {vpnStatus?.platform === "linux" && (
                            <Paragraph>No Linux, a ativação moverá o cliente Discord para um network namespace exclusivo, solicitando elevação (pkexec) se necessário e relançando o cliente.</Paragraph>
                        )}
                        {progress?.server && <Paragraph>Servidor escolhido: {progress.server}</Paragraph>}
                        {typeof progress?.downloadMbps === "number" && typeof progress.uploadMbps === "number" && <Paragraph>Teste medido: {progress.downloadMbps} Mbps down · {progress.uploadMbps} Mbps up</Paragraph>}
                    </div>
                    </div>
                )}
            </div>
        </Modal>
    );
}

function openPluginOnboarding() {
    if (onboardingOpen) return;
    if (onboardingTimer !== null) {
        clearTimeout(onboardingTimer);
        onboardingTimer = null;
    }
    onboardingOpen = true;
    const modalToken = ++onboardingModalToken;
    try {
        const modalKey = openModal(props => <PluginOnboardingModal modalProps={props} onClosed={() => {
            if (modalToken !== onboardingModalToken) return;
            onboardingOpen = false;
            onboardingModalKey = null;
        }} />);
        if (modalToken === onboardingModalToken && onboardingOpen) onboardingModalKey = modalKey;
    } catch (error) {
        onboardingOpen = false;
        onboardingModalKey = null;
        logger.error("Falha ao abrir o assistente do GoLiveBypass", error);
    }
}

function AboutPlugin() {
    const { vpnMode } = settings.use(["vpnMode"]);
    const customMode = vpnMode === "custom";
    return (
        <>
            <section>
                <Paragraph><strong>Assistente de configuração</strong> — {customMode ? "valide sua configuração WireGuard personalizada dentro do Discord." : "configure sua conta Proton e prepare a rota WireGuard dentro do Discord."}</Paragraph>
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
        label: `v${PLUGIN_VERSION} · instalada`, tone: "neutral", available: false
    });
    const [status, setStatus] = useState<PluginUpdateStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [operation, setOperation] = useState<"checking" | "updating" | null>(null);
    const mountedRef = React.useRef(false);
    const policyRevisionRef = React.useRef(0);
    const statusRequestRef = React.useRef(0);
    const operationIdRef = React.useRef(0);
    const operationBusyRef = React.useRef(false);
    const selectedUpdatePolicy = {
        enabled: autoUpdate,
        channel: normalizedUpdateChannel(updateChannel),
    };

    const isCurrent = (revision: number) => mountedRef.current && revision === policyRevisionRef.current;

    const refreshStatus = async (revision = policyRevisionRef.current, options?: { preserveAvailable?: boolean }): Promise<PluginUpdateStatus | null> => {
        if (!isCurrent(revision)) return null;
        const request = ++statusRequestRef.current;
        const statusRequest = readPluginUpdateStatus();
        if (!statusRequest) return null;
        const isRequestCurrent = () => isCurrent(revision) && request === statusRequestRef.current;
        try {
            const next = await statusRequest;
            if (!isRequestCurrent()) return null;
            if (!pluginUpdateStatusMatchesPolicy(next, selectedUpdatePolicy)) return null;
            setStatus(next);
            if (next.lastError) {
                notifyPluginUpdateFailure(next.current, next.channel, next.lastError);
            } else {
                lastNotifiedUpdateErrorKey = null;
                lastSuppressedUpdateErrorKey = null;
            }
            if (next.pending) {
                notifyPendingPluginUpdate(next.current, next.pendingVersion, next.pendingChannel || next.channel);
                const version = next.pendingVersion ? `v${next.pendingVersion}` : "a nova versão";
                setState({ label: `${version} pronta; recarregue o Discord`, tone: "warning", available: false });
            } else if (next.lastError) {
                setState({ label: `v${next.current || PLUGIN_VERSION} · atualização falhou`, tone: "neutral", available: false });
            } else if (!options?.preserveAvailable) {
                setState(prev => ({ label: prev.label, tone: prev.tone, available: false }));
            }
            return next;
        } catch (error) {
            if (isRequestCurrent()) {
                logger.error("Falha ao consultar o estado do updater do plugin", error);
                setState(prev => ({ ...prev, available: false }));
            }
            return null;
        }
    };

    const beginOperation = (nextOperation: "checking" | "updating") => {
        if (!Native || busy || operationBusyRef.current) return null;
        const operationRevision = policyRevisionRef.current;
        const operationId = ++operationIdRef.current;
        operationBusyRef.current = true;
        setBusy(true);
        setOperation(nextOperation);
        return { operationRevision, operationId };
    };

    const check = async () => {
        const native = Native;
        if (!native) return;
        const operation = beginOperation("checking");
        if (!operation) return;
        const { operationRevision, operationId } = operation;
        const isOperationMounted = () => isCurrent(operationRevision) && operationId === operationIdRef.current;
        try {
            const result = await withTimeout(
                () => native.checkPluginUpdate(selectedUpdatePolicy),
                PLUGIN_UPDATE_CHECK_TIMEOUT_MS,
                "A verificação de atualização excedeu o tempo limite.",
            ) as PluginUpdateCheckResult;
            if (!isOperationMounted()) return;
            const current = result.current || PLUGIN_VERSION;
            let isAvailable = false;
            if (!result.ok) {
                const detailText = result.error || "O updater recusou a verificação.";
                suppressPluginUpdateFailure(result.current, result.channel || selectedUpdatePolicy.channel, detailText);
                const detail = result.error ? ` · ${result.error.slice(0, 48)}` : "";
                setState({ label: `v${current} · verificação falhou${detail}`, tone: "neutral", available: false });
            } else if (result.pending) {
                const version = result.latest ? `v${result.latest}` : "a nova versão";
                notifyPendingPluginUpdate(result.current, result.latest, result.pendingChannel || result.channel || selectedUpdatePolicy.channel);
                setState({ label: `${version} pronta; recarregue o Discord`, tone: "warning", available: false });
            } else if (result.available) {
                isAvailable = true;
                setState({ label: `v${current} · v${result.latest || "nova"} disponível`, tone: "warning", available: true });
            } else {
                setState({ label: `v${current} · sem atualização disponível`, tone: "success", available: false });
            }
            await refreshStatus(operationRevision, { preserveAvailable: isAvailable });
            if (!isOperationMounted()) return;
        } catch (error) {
            if (isOperationMounted()) {
                const detailText = error instanceof Error ? error.message : String(error);
                const currentVersion = status?.current || PLUGIN_VERSION;
                suppressPluginUpdateFailure(currentVersion, status?.channel || selectedUpdatePolicy.channel, detailText);
                const detail = error instanceof Error ? ` · ${error.message.slice(0, 48)}` : "";
                setState({ label: `v${currentVersion} · verificação falhou${detail}`, tone: "neutral", available: false });
            }
        } finally {
            if (operationId === operationIdRef.current) operationBusyRef.current = false;
            if (isOperationMounted()) {
                setBusy(false);
                setOperation(null);
            }
        }
    };

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            policyRevisionRef.current++;
            operationIdRef.current++;
            operationBusyRef.current = false;
        };
    }, []);

    useEffect(() => {
        const revision = ++policyRevisionRef.current;
        let disposed = false;
        const isRevisionCurrent = () => !disposed && isCurrent(revision);
        setState({
            label: `v${status?.current || PLUGIN_VERSION} · instalada`,
            tone: "neutral",
            available: false
        });
        const configure = async () => {
            try {
                const configureUpdates = Native?.configurePluginUpdates;
                if (typeof configureUpdates === "function") {
                    await configureUpdates({
                        enabled: autoUpdate,
                        channel: normalizedUpdateChannel(updateChannel)
                    });
                }
                if (isRevisionCurrent()) await refreshStatus(revision);
            } catch (error) {
                if (isRevisionCurrent()) logger.error("Falha ao configurar o updater do plugin", error);
            }
        };
        void configure();

        const timer = setInterval(() => {
            if (isRevisionCurrent()) void refreshStatus(revision);
        }, PLUGIN_UPDATE_STATUS_POLL_INTERVAL_MS);
        return () => {
            disposed = true;
            policyRevisionRef.current++;
            statusRequestRef.current++;
            operationIdRef.current++;
            operationBusyRef.current = false;
            if (mountedRef.current) {
                setBusy(false);
                setOperation(null);
            }
            clearInterval(timer);
        };
    }, [updateChannel, autoUpdate]);

    const update = async () => {
        const native = Native;
        if (!native) return;
        const operation = beginOperation("updating");
        if (!operation) return;
        const { operationRevision, operationId } = operation;
        const isOperationMounted = () => isCurrent(operationRevision) && operationId === operationIdRef.current;
        let failureContext: { current?: string; channel: PluginUpdateChannel; detail: string } | null = null;
        try {
            const result = await withTimeout(
                () => native.updatePlugin(selectedUpdatePolicy),
                PLUGIN_UPDATE_INSTALL_TIMEOUT_MS,
                "A atualização do plugin excedeu o tempo limite.",
            ) as PluginUpdateResult;
            if (!isOperationMounted()) return;
            if (!result.ok) {
                const detail = result.error || "O updater recusou a atualização.";
                failureContext = { current: result.current, channel: result.channel || selectedUpdatePolicy.channel, detail };
                suppressPluginUpdateFailure(failureContext.current, failureContext.channel, failureContext.detail);
                setState({ label: `v${result.current || PLUGIN_VERSION} · atualização falhou`, tone: "warning", available: false });
                throw new Error(detail);
            }
            if (result.updated || result.pending || result.reloadRequired) {
                const version = result.latest || result.current;
                notifyPendingPluginUpdate(result.current, version, result.pendingChannel || result.channel || selectedUpdatePolicy.channel);
                setState({
                    label: version ? `v${version} pronta; recarregue o Discord` : "Atualização pronta; recarregue o Discord",
                    tone: "warning",
                    available: false
                });
                await refreshStatus(operationRevision);
                if (!isOperationMounted()) return;
            } else {
                setState({ label: `v${result.current || PLUGIN_VERSION} · sem atualização disponível`, tone: "success", available: false });
            }
        } catch (error) {
            if (isOperationMounted()) {
                const detail = error instanceof Error ? error.message : String(error);
                const currentVersion = failureContext?.current || status?.current || PLUGIN_VERSION;
                suppressPluginUpdateFailure(
                    currentVersion,
                    failureContext?.channel || status?.channel || selectedUpdatePolicy.channel,
                    failureContext?.detail || detail,
                );
                setState({ label: `v${currentVersion} · atualização falhou`, tone: "warning", available: false });
                showToast(`GoLiveBypass não conseguiu atualizar: ${detail}`, Toasts.Type.FAILURE);
            }
        } finally {
            if (operationId === operationIdRef.current) operationBusyRef.current = false;
            if (isOperationMounted()) {
                setBusy(false);
                setOperation(null);
            }
        }
    };

    const channelLabel = updateChannel === "beta" ? "Beta (opt-in)" : "Estável";
    const checkedLabel = typeof status?.lastCheckedAt === "number"
        ? ` · última consulta ${new Date(status.lastCheckedAt).toLocaleTimeString()}`
        : "";
    const operationLabel = operation === "checking"
        ? "Verificando atualizações…"
        : operation === "updating"
            ? "Baixando e preparando a atualização…"
            : state.label;

    return (
        <Card defaultPadding>
            <section aria-label="Estado das atualizações do GoLiveBypass">
                <div role="status" aria-live="polite" aria-busy={busy} aria-atomic="true">
                    <Paragraph>
                        <strong>Atualizações do GoLiveBypass</strong> — canal {channelLabel}; automática {autoUpdate ? "ligada" : "desligada"}{checkedLabel}
                    </Paragraph>
                    <Paragraph><strong>{operationLabel}</strong></Paragraph>
                    {status?.pending && <Paragraph>Atualização {status.pendingVersion ? `v${status.pendingVersion}` : "preparada"} pronta; recarregue o Discord manualmente para aplicar.</Paragraph>}
                    {status?.lastError && <Paragraph>Último erro do updater: {status.lastError.slice(0, 240)}</Paragraph>}
                </div>
                <Paragraph>
                    <Button onClick={() => void check()} disabled={busy}>{busy ? "Em andamento…" : "Verificar"}</Button>{" "}
                    {state.available && <Button onClick={() => void update()} disabled={busy}>Atualizar</Button>}
                </Paragraph>
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
    updateDeferredVersion: {
        type: OptionType.STRING,
        description: "Versão de atualização cujo aviso foi adiado.",
        default: "",
        hidden: true,
    },
    updateDeferredUntil: {
        type: OptionType.STRING,
        description: "Momento até o qual o aviso de atualização permanece adiado.",
        default: "",
        hidden: true,
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
        description: "Configuração .conf WireGuard importada para a pasta privada do plugin. Use o botão no assistente ou no painel VPN para selecionar ou trocar o arquivo.",
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
    state: VpnState | string;
    platform?: VpnPlatform | string;
    architecture?: string;
    owned?: boolean;
    active: boolean;
    generation?: number;
    discordPid?: number | null;
    profilePath?: string | null;
    configPath?: string | null;
    namespace?: string | null;
    interfaceName?: string | null;
    requiresRelaunch?: boolean;
    dependencies?: string[];
    externalReason: string | null;
    lastDiagnostic: { detail: string; ok?: boolean; kind?: string } | null;
    message: string;
    sessionStorage?: "safe-storage" | "file" | "memory-only";
}

function VpnPanel() {
    const { vpnMode, customConfigPath } = settings.use(["vpnMode", "customConfigPath"]);
    const customMode = vpnMode === "custom";
    const [status, setStatus] = useState<PluginVpnStatus | null>(null);
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [twoFactorCode, setTwoFactorCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [optimizing, setOptimizing] = useState(false);
    const [loginActive, setLoginActive] = useState(false);
    const [loginCancelRequested, setLoginCancelRequested] = useState(false);
    const mountedRef = React.useRef(false);
    const usernameRef = React.useRef("");
    const refreshRequestRef = React.useRef(0);
    const loginRequestIdRef = React.useRef<string | null>(null);

    const refresh = async () => {
        if (!Native) return;
        const request = ++refreshRequestRef.current;
        const isCurrent = () => mountedRef.current && request === refreshRequestRef.current;
        try {
            const [nextStatus, saved] = await Promise.all([Native.getVpnStatus(), Native.getProtonSettings()]);
            if (!isCurrent()) return;
            setStatus(nextStatus as PluginVpnStatus);
            const savedRecord = saved as { protonUsername?: unknown; sessionUsername?: unknown };
            const savedUsername = typeof savedRecord.protonUsername === "string" && savedRecord.protonUsername
                ? savedRecord.protonUsername
                : savedRecord.sessionUsername;
            if (!usernameRef.current && typeof savedUsername === "string" && savedUsername) {
                usernameRef.current = savedUsername;
                setUsername(savedUsername);
            }
        } catch (error) {
            if (isCurrent()) logger.error("Falha ao ler o estado da VPN do plugin", error);
        }
    };

    useEffect(() => {
        mountedRef.current = true;
        void refresh();
        const timer = setInterval(() => void refresh(), 5_000);
        return () => {
            mountedRef.current = false;
            refreshRequestRef.current++;
            const activeRequestId = loginRequestIdRef.current;
            loginRequestIdRef.current = null;
            if (activeRequestId && typeof Native?.cancelProtonLogin === "function") {
                void Promise.resolve(Native.cancelProtonLogin(activeRequestId)).catch(error => logger.error("Falha ao cancelar login Proton ao desmontar o painel", error));
            }
            clearInterval(timer);
        };
    }, []);

    const call = async (operation: () => Promise<unknown>, successMessage?: string) => {
        if (busy) return;
        setBusy(true);
        try {
            const result = await operation() as { success?: boolean; error?: string; message?: string };
            if (!mountedRef.current) return;
            if (result.success === false) throw new Error(result.error || result.message || "Operação VPN recusada.");
            if (successMessage) showToast(successMessage, Toasts.Type.SUCCESS);
            await refresh();
        } catch (error) {
            if (mountedRef.current) showToast(`GoLiveBypass: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
        } finally {
            if (mountedRef.current) setBusy(false);
        }
    };
    const selectCustomConfig = async () => {
        if (!Native || busy || optimizing || typeof Native.selectWireGuardConfig !== "function") return;
        setBusy(true);
        try {
            const result = await Native.selectWireGuardConfig() as {
                success?: boolean;
                cancelled?: boolean;
                path?: string;
                error?: string;
            };
            if (!mountedRef.current || result.cancelled) return;
            if (result.success !== true || typeof result.path !== "string" || !result.path) {
                throw new Error(result.error || "Não foi possível importar a configuração WireGuard.");
            }
            settings.store.customConfigPath = result.path;
            showToast("Configuração WireGuard importada.", Toasts.Type.SUCCESS);
            await refresh();
        } catch (error) {
            if (mountedRef.current) showToast(`GoLiveBypass: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
        } finally {
            if (mountedRef.current) setBusy(false);
        }
    };


    const login = async () => {
        if (!Native || busy || optimizing) return;
        const requestId = `plugin-panel-login-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        loginRequestIdRef.current = requestId;
        setLoginActive(true);
        setLoginCancelRequested(false);
        setBusy(true);
        try {
            const result = await Native.loginProton({ username, password, twoFactorCode, requestId });
            if (!mountedRef.current) return;
            if (!result.success) {
                if (result.code === "CANCELLED") return;
                throw new Error(result.error || result.message || "Login Proton recusado.");
            }
            setPassword("");
            setTwoFactorCode("");
            showToast(
                result.persisted === false
                    ? "Sessão Proton ativa nesta execução do Discord; esta máquina não guarda a sessão e o login será pedido de novo ao reiniciar."
                    : "Sessão Proton salva na pasta privada do plugin.",
                Toasts.Type.SUCCESS
            );
            await refresh();
        } catch (error) {
            if (mountedRef.current) showToast(`Login Proton: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
        } finally {
            if (loginRequestIdRef.current === requestId) loginRequestIdRef.current = null;
            if (mountedRef.current) {
                setLoginActive(false);
                setLoginCancelRequested(false);
            }
            if (mountedRef.current) setBusy(false);
        }
    };

    const cancelLogin = () => {
        const activeRequestId = loginRequestIdRef.current;
        if (!activeRequestId || loginCancelRequested || typeof Native?.cancelProtonLogin !== "function") return;
        setLoginCancelRequested(true);
        setPassword("");
        setTwoFactorCode("");
        void Promise.resolve(Native.cancelProtonLogin(activeRequestId)).catch(error => logger.error("Falha ao cancelar login Proton", error));
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
            if (!mountedRef.current) return;
            if (!result.success) throw new Error(result.error || "Não foi possível otimizar a rota Proton.");
            showToast(
                status?.active
                    ? "Rota Proton preparada e aplicada na sessão ativa do Discord."
                    : "Rota Proton preparada. Use \"Ativar agora\" para aplicar a rota; o Discord será reiniciado.",
                Toasts.Type.SUCCESS
            );
            await refresh();
        } catch (error) {
            if (mountedRef.current) showToast(`Otimização Proton: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
        } finally {
            if (mountedRef.current) setOptimizing(false);
        }
    };

    if (!Native) return <Paragraph>A parte desktop do plugin não está disponível nesta instalação.</Paragraph>;

    const statusLabel = status?.active ? `Ativa · ${status.message}` : status?.message || "Consultando o estado da VPN…";
    const platformLabel = status?.platform === "linux"
        ? `Linux ${status.architecture || "x64"}`
        : status?.platform === "windows"
            ? `Windows ${status.architecture || "x64"}`
            : status?.platform === "unsupported"
                ? `Plataforma não suportada (${status.architecture || "arquitetura incompatível"})`
                : "Plataforma desconhecida";

    const missingDependencies = Boolean(status?.dependencies && status.dependencies.length > 0);
    const requiresRelaunch = Boolean(status?.requiresRelaunch);
    const isAuthorizing = status?.state === "authorizing";
    const isBlockedExternal = status?.state === "blocked_external";
    const isRecoveryRequired = status?.state === "recovery_required";
    const isDependencyMissing = status?.state === "dependency_missing" || missingDependencies;
    const isUnsupported = status?.platform === "unsupported";

    const activationBlockReason = isUnsupported
        ? (status?.externalReason || "Plataforma não suportada")
        : isDependencyMissing
            ? (status?.dependencies?.length ? `Dependências ausentes: ${status.dependencies.join(", ")}` : (status?.externalReason || "Dependências ausentes"))
            : isBlockedExternal
                ? (status?.externalReason || "Túnel externo ativo")
                : isRecoveryRequired
                    ? "Recuperação de rede pendente"
                    : requiresRelaunch
                        ? "Reinicialização necessária"
                        : null;

    const canActivate = Boolean(status && !busy && !optimizing && !status.active && !activationBlockReason);

    const isFlatpak = Boolean(
        (status?.externalReason && /flatpak/i.test(status.externalReason))
        || status?.dependencies?.some(d => /flatpak/i.test(d))
    );

    return (
        <section aria-label="Painel de controle da VPN do GoLiveBypass">
            <Paragraph><strong>VPN do plugin</strong> — {statusLabel} ({platformLabel})</Paragraph>
            {isAuthorizing && status?.platform === "linux" && (
                <Paragraph role="status" aria-live="assertive" aria-busy="true">
                    <strong>Autorização necessária:</strong> Uma janela do sistema solicitará a senha administrativa. Informe a senha do sistema, não a senha da conta Proton.
                </Paragraph>
            )}

            {isBlockedExternal && (
                <Paragraph role="alert" aria-live="polite">
                    <strong>Túnel externo detectado:</strong> {status?.externalReason || "WireSock ou túnel externo detectado. O plugin não vai pará-lo nem assumir seu túnel."}
                </Paragraph>
            )}

            {isRecoveryRequired && (
                <Paragraph role="alert" aria-live="assertive">
                    <strong>Recuperação necessária:</strong> A última limpeza não foi confirmada. Restaure a rede antes de tentar nova ativação.
                </Paragraph>
            )}

            {isDependencyMissing && (
                <Paragraph role="alert" aria-live="polite">
                    <strong>Dependências ausentes:</strong> {status?.dependencies?.length ? status.dependencies.join(", ") : (status?.externalReason || "Dependências de rede não encontradas")}. No Linux, certifique-se de que <code>iproute2</code>, <code>wireguard-tools</code> e <code>pkexec</code> estão instalados.
                </Paragraph>
            )}

            {isFlatpak && (
                <Paragraph role="note" aria-live="polite">
                    <strong>Ambiente Flatpak:</strong> O cliente precisa de permissão para executar comandos no host via <code>flatpak-spawn --host</code>. Se necessário, execute: <code>flatpak override --user --talk-name=org.freedesktop.Flatpak &lt;app-id&gt;</code>.
                </Paragraph>
            )}

            {requiresRelaunch && (
                <Paragraph role="status" aria-live="polite">
                    <strong>Relaunch necessário:</strong> O namespace de rede da VPN está preparado, mas este processo do Discord ainda está fora dele. Reinicie o cliente para que o Discord entre no namespace isolado.
                </Paragraph>
            )}

            {status?.lastDiagnostic && !status.lastDiagnostic.ok && (
                <Paragraph role="status" aria-live="polite">
                    <strong>Diagnóstico:</strong> {status.lastDiagnostic.detail}
                </Paragraph>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {customMode ? (
                    <>
                        <Paragraph>{typeof customConfigPath === "string" && customConfigPath.trim() ? "Modo personalizado: arquivo WireGuard importado; nenhum login Proton é necessário." : "Modo personalizado: selecione um arquivo WireGuard para continuar."}</Paragraph>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                            <Button onClick={() => void selectCustomConfig()} disabled={busy || optimizing}>
                                {typeof customConfigPath === "string" && customConfigPath.trim() ? "Trocar arquivo .conf" : "Selecionar arquivo .conf"}
                            </Button>
                        </div>
                    </>
                ) : (
                    <>
                        {status?.sessionStorage === "memory-only" && (
                            <Paragraph role="note" aria-live="polite">
                                <strong>Esta máquina não guarda a sessão:</strong> o armazenamento seguro do sistema (Secret Service/libsecret) não está disponível, então a sessão Proton vale só enquanto o Discord estiver aberto e o login será pedido de novo depois de reiniciá-lo.
                            </Paragraph>
                        )}
                        <TextInput value={username} onChange={value => { usernameRef.current = value; setUsername(value); }} placeholder="Usuário ProtonVPN" aria-label="Usuário ProtonVPN" disabled={busy || optimizing} />
                        <TextInput value={password} onChange={setPassword} placeholder="Senha ProtonVPN" aria-label="Senha ProtonVPN" type="password" disabled={busy || optimizing} />
                        <TextInput value={twoFactorCode} onChange={setTwoFactorCode} placeholder="Código 2FA (se solicitado)" aria-label="Código 2FA (se solicitado)" disabled={busy || optimizing} />
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                            {loginActive ? <Button onClick={cancelLogin} disabled={loginCancelRequested}>{loginCancelRequested ? "Cancelando…" : "Cancelar login"}</Button> : <Button onClick={() => void login()} disabled={busy || optimizing || !username.trim()}>Entrar no Proton</Button>}{" "}
                            <Button onClick={() => void optimize()} disabled={busy || optimizing || !username.trim()}>{optimizing ? "Otimizando…" : "Otimizar rota"}</Button>{" "}
                            <Button onClick={() => void call(() => Native.logoutProton(), "Sessão Proton removida.")} disabled={busy || optimizing}>Sair</Button>
                        </div>
                    </>
                )}
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    {requiresRelaunch ? (
                        <Button
                            onClick={() => void call(() => (typeof Native?.restartDiscord === "function" ? Native.restartDiscord() : Native.enable()), "Reiniciando Discord no namespace…")}
                            disabled={busy || optimizing}
                        >
                            Reiniciar Discord no namespace
                        </Button>
                    ) : (
                        <Button
                            onClick={() => void call(() => Native.enable())}
                            disabled={!canActivate}
                            title={activationBlockReason || undefined}
                        >
                            {activationBlockReason ? `Ativar agora (${activationBlockReason})` : "Ativar agora"}
                        </Button>
                    )}{" "}
                    <Button onClick={() => void call(() => Native.restoreNetwork(), "Rede restaurada.")} disabled={busy || optimizing}>Restaurar rede</Button>{" "}
                    <Button onClick={() => void call(() => Native.testWireGuardConfig(customConfigPath))} disabled={busy || optimizing}>Testar .conf</Button>
                </div>
            </div>
            <Paragraph>
                {status?.platform === "linux"
                    ? `Linux ${status.architecture || "x64"}: isolamento por network namespace dedicado (ip netns exec), mantendo o restante do sistema na rota normal. Probes de rota são apenas diagnóstico de conectividade e não comprovam localização geográfica.`
                    : status?.platform === "windows"
                        ? `Windows ${status.architecture || "x64"}: o túnel usa AllowedApps somente para o executável do Discord e o Update.exe. Probes de rota são apenas diagnóstico de conectividade e não comprovam localização geográfica.`
                        : status?.platform === "unsupported"
                            ? `Plataforma não suportada (${status?.platform || "desconhecido"} ${status?.architecture || ""}). O plugin suporta Windows x64 e Linux x64.`
                            : "Isolamento por processo (AllowedApps no Windows x64 ou network namespace no Linux x64). Probes de rota são apenas diagnósticos de conectividade e não comprovam localização geográfica."}
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
    if (typeof Native?.logFromRenderer === "function") {
        void Native.logFromRenderer(message).catch(() => {
            // Sem o registro em arquivo ainda resta o console; nao vale quebrar o fluxo por isso.
        });
    }
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

    const senderClaimed = !claimed.known ? null : normalizeStreamClaim(claimed.value);
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
        const lifecycleGeneration = ++pluginLifecycleGeneration;
        const isLifecycleCurrent = () => lifecycleGeneration === pluginLifecycleGeneration;
        forceRegion();
        startStreamClaimWatch();

        const onboardingRequired = Native && settings.store.onboardingCompleted !== true;
        if (onboardingTimer !== null) clearTimeout(onboardingTimer);
        if (onboardingRequired) {
            onboardingTimer = setTimeout(() => {
                onboardingTimer = null;
                if (isLifecycleCurrent() && settings.store.onboardingCompleted !== true) openPluginOnboarding();
            }, 2_500);
        }

        const configure = Native?.configurePluginUpdates;
        if (typeof configure === "function") {
            void configure({
                enabled: settings.store.autoUpdate !== false,
                channel: normalizedUpdateChannel(settings.store.updateChannel)
            }).catch(error => {
                if (isLifecycleCurrent()) logger.error("Falha ao configurar o updater do plugin", error);
            });
        }

        // O aviso aparece mesmo para quem nunca abre a aba de configuração. O processo
        // principal faz a checagem/download; o renderer observa continuamente se há
        // reload pendente ou uma falha nova, inclusive depois da primeira consulta.
        schedulePluginUpdateStatusObservation(lifecycleGeneration);

        // A primeira execução precisa deixar o usuário atravessar as três etapas do
        // assistente antes de qualquer ativação que possa relançar o Discord.
        //
        // Este caminho é automático (start do renderer), então usa `enableAutomatic`: ele não
        // relança o Discord e respeita a suspensão de autostart. O relaunch ficou reservado
        // para o botão do painel (`Native.enable`), porque repeti-lo a cada boot transformava
        // um relaunch não confirmado num ciclo infinito de reinícios do Discord. Bridge antiga
        // sem `enableAutomatic` simplesmente não ativa sozinha -- o painel continua ativando.
        if (!onboardingRequired && typeof Native?.enableAutomatic === "function") {
            void Native.enableAutomatic().then(result => {
                if (!isLifecycleCurrent()) return;
                if (result?.success === false && !result.suppressed)
                    showToast(`GoLiveBypass não conseguiu ativar a VPN: ${result.error || result.message || "veja o log"}`, Toasts.Type.FAILURE);
            }).catch(error => {
                if (isLifecycleCurrent()) logger.error("Failed to reach the desktop process", error);
            });
        }
    },

    stop() {
        dismissPluginUpdateOverlays();
        pluginLifecycleGeneration++;
        lastNotifiedPendingVersion = null;
        lastNotifiedUpdateErrorKey = null;
        lastSuppressedUpdateErrorKey = null;
        if (onboardingTimer !== null) {
            clearTimeout(onboardingTimer);
            onboardingTimer = null;
        }
        if (updateCheckTimer !== null) {
            clearTimeout(updateCheckTimer);
            updateCheckTimer = null;
        }
        if (onboardingModalKey !== null) {
            const modalKey = onboardingModalKey;
            onboardingModalToken++;
            onboardingModalKey = null;
            onboardingOpen = false;
            closeDiscordModal(modalKey);
        } else {
            onboardingModalToken++;
            onboardingOpen = false;
        }
        stopStreamClaimWatch();
        restoreRegion();
        if (typeof Native?.shutdown === "function") {
            void Native.shutdown().catch(error => logger.error("Failed to reach the desktop process", error));
        }
    }
});
