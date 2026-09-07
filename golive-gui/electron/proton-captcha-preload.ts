// Este preload roda em sandbox: use apenas o require nativo do Electron e nao
// exponha APIs ou objetos Node para a pagina do CAPTCHA.
const { ipcRenderer } = require("electron");
import { PROTON_CAPTCHA_IPC_CHANNEL } from "./proton-captcha";

const MAX_TOKEN_LENGTH = 16_384;
const ACCEPTED_TYPES = new Set(["pm_captcha", "proton_captcha"]);

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data;
  const type = data && data.type;
  const token = data && data.token;
  if (!ACCEPTED_TYPES.has(type) || typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return;
  ipcRenderer.send(PROTON_CAPTCHA_IPC_CHANNEL, { type, token });
});
