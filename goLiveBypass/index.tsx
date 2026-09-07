/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { Paragraph } from "@components/Paragraph";
import { copyWithToast } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { useAwaiter } from "@utils/react";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { Button, Constants, MaskedLink, React, RestAPI, SearchableSelect, TextInput, showToast, Toasts, UserStore, useEffect, useState } from "@webpack/common";

import {
    evaluateStreamClaim,
    initialStreamClaimState,
    type StreamClaimState
} from "./stability";

const Native = VencordNative?.pluginHelpers?.GoLiveBypass as PluginNative<typeof import("./native")> | undefined;

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

const PLUGIN_VERSION = "1.1.12-beta.13";

const AUTOMATIC = "";
const VOICE_KEYS: "voiceRegion"[] = ["voiceRegion"];
const STREAM_KEYS: "streamRegion"[] = ["streamRegion"];

let original: RegionStore | undefined;
let streamClaimTimer: ReturnType<typeof setInterval> | null = null;
let updateCheckTimer: ReturnType<typeof setTimeout> | null = null;
let streamClaimState: StreamClaimState = initialStreamClaimState();
let streamClaimStatus = "idle";
let streamClaimProbeFailed = false;

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

function AboutPlugin() {
    return (
        <>
            <VpnPanel />
            <PluginUpdateSettings />
            <Paragraph>
                Feito por bezumiya. Código e issues no <MaskedLink href="https://github.com/bezumiya/GoLiveBypass">GitHub</MaskedLink>, e novidades no <MaskedLink href="https://twitter.com/obezumiya">Twitter</MaskedLink>.
            </Paragraph>
        </>
    );
}

function PluginUpdateSettings() {
    const [state, setState] = useState<{ label: string; tone: "neutral" | "success" | "warning" }>({
        label: `v${PLUGIN_VERSION} · instalada`, tone: "neutral"
    });
    const [busy, setBusy] = useState(false);

    const check = async () => {
        if (!Native || busy) return;
        setBusy(true);
        try {
            const result = await Native.checkPluginUpdate();
            if (!result.ok) {
                const detail = result.error ? ` · ${result.error.slice(0, 48)}` : "";
                setState({ label: `v${PLUGIN_VERSION} · verificação falhou${detail}`, tone: "neutral" });
            } else if (result.available) {
                setState({ label: `v${PLUGIN_VERSION} · v${result.latest} disponível`, tone: "warning" });
            } else {
                setState({ label: `v${PLUGIN_VERSION} · atualizada`, tone: "success" });
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
        }
    };

    useEffect(() => { void check(); }, []);

    const update = async () => {
        if (!Native || busy) return;
        setBusy(true);
        try {
            const result = await Native.updatePlugin();
            if (result.updated) {
                setState({ label: `v${result.latest} · atualizada`, tone: "success" });
                showToast("GoLiveBypass atualizado. Recarregue o Discord para aplicar a nova versão.", Toasts.Type.SUCCESS);
            } else {
                setState({ label: `v${result.latest} · atualizada`, tone: "success" });
            }
        } catch (error) {
            setState({ label: `v${PLUGIN_VERSION} · atualização falhou`, tone: "warning" });
            showToast(`GoLiveBypass não conseguiu atualizar: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Paragraph>
            <strong>{state.label}</strong>{" "}
            <Button onClick={() => void check()} disabled={busy}>{busy ? "Verificando…" : "Verificar"}</Button>{" "}
            {state.tone === "warning" && <Button onClick={() => void update()} disabled={busy}>Atualizar</Button>}
        </Paragraph>
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

// Guarda especifica para o falso "transmitindo"/erro 2001 visto no fogo da
// beta 13. Nao tenta inferir fps nem fechar sockets: as stores do renderer so
// provam que a UI afirma uma Live e se a conexao nativa de stream chegou a
// existir. Dado ausente falha fechado; a unica acao e um aviso manual.
function pollStreamClaimOnce() {
    const claimed = readStore(ApplicationStreamingStore, "getCurrentUserActiveStream");
    const nativeKeys = readStore(StreamRTCConnectionStore, "getAllActiveStreamKeys");

    const senderClaimed = !claimed.known || claimed.value === undefined
        ? null
        : claimed.value !== null;
    const nativeStreamCount = nativeKeys.known ? collectionCount(nativeKeys.value) : null;
    const decision = evaluateStreamClaim({
        now: Date.now(), senderClaimed, nativeStreamCount
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
    pollStreamClaim();
    streamClaimTimer = setInterval(pollStreamClaim, 5_000);
}

function stopStreamClaimWatch() {
    if (streamClaimTimer !== null) clearInterval(streamClaimTimer);
    streamClaimTimer = null;
    streamClaimState = initialStreamClaimState();
    streamClaimStatus = "idle";
    streamClaimProbeFailed = false;
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
    lines.push(`minha transmissao ativa  ${JSON.stringify(ask(ApplicationStreamingStore, "getCurrentUserActiveStream"))}`);
    lines.push(`transmissoes visiveis    ${JSON.stringify(ask(ApplicationStreamingStore, "getAllActiveStreams"))}`);
    lines.push(`conexoes de midia        ${JSON.stringify(ask(StreamRTCConnectionStore, "getAllActiveStreamKeys"))}`);
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
        return typeof region === "string" && region !== AUTOMATIC ? region : fallback;
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

        // O aviso aparece mesmo para quem nunca abre a aba de configuracao. Consulta uma vez
        // por sessao; o botao da configuracao continua disponivel para uma consulta manual.
        if (updateCheckTimer !== null) clearTimeout(updateCheckTimer);
        updateCheckTimer = setTimeout(() => {
            updateCheckTimer = null;
            Native?.checkPluginUpdate().then(result => {
                if (result.ok && result.available)
                    showToast(`GoLiveBypass v${result.latest} disponível. Abra as configurações do plugin para atualizar.`, Toasts.Type.MESSAGE);
            }).catch(() => { });
        }, 8_000);

        Native?.enable().then(result => {
            if (result?.success === false)
                showToast(`GoLiveBypass não conseguiu ativar a VPN: ${result.error || result.message || "veja o log"}`, Toasts.Type.FAILURE);
        }).catch(error => logger.error("Failed to reach the desktop process", error));
    },

    stop() {
        if (updateCheckTimer !== null) {
            clearTimeout(updateCheckTimer);
            updateCheckTimer = null;
        }
        stopStreamClaimWatch();
        restoreRegion();
        Native?.shutdown().catch(error => logger.error("Failed to reach the desktop process", error));
    }
});
