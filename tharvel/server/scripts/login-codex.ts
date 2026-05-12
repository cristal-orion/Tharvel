/**
 * Login OAuth a ChatGPT Plus/Pro (Codex) usando l'API ufficiale del SDK.
 *
 * Salva le credenziali in ~/.pi/agent/auth.json (path standard letto dal server).
 * Da preferire al binario `pi-ai` minimale, che salva in CWD ed è incompatibile
 * col path che Tharvel server usa di default.
 *
 * Uso: npm run login:codex (dal workspace `server/`)
 */
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { createInterface } from "node:readline";
import { createServer } from "node:http";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) =>
  new Promise<string>((resolve) => rl.question(q + " ", resolve));

// Bug SDK 0.73: `pi-ai/utils/oauth/openai-codex.js` carica `node:crypto` e
// `node:http` con dynamic import asincroni e non li attende prima di usarli.
// Forziamo qui il warm-up dei moduli prima di chiamare `auth.login`.
await import("node:crypto");
await import("node:http");
await new Promise((resolve) => setTimeout(resolve, 100));

// Preflight: la porta 1455 è hardcoded nel SDK + registrata come redirect_uri
// nell'app OpenAI Codex. Se è occupata da un altro processo (es. BrowserOS),
// il login OAuth fallisce con messaggi fuorvianti tipo "Invalid OAuth state".
async function checkPort1455Free(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(
          "Porta 1455 occupata. Il callback OAuth Codex non può ricevere il redirect.\n" +
          "Causa probabile: BrowserOS o altro server è in esecuzione su 127.0.0.1:1455.\n" +
          "Diagnosi: ss -ltnp | grep ':1455'\n" +
          "Fix: chiudi il processo che occupa la porta, poi rilancia npm run login:codex."
        ));
      } else {
        reject(err);
      }
    });
    probe.listen(1455, "127.0.0.1", () => {
      probe.close(() => resolve());
    });
  });
}

await checkPort1455Free();

async function main() {
  const auth = AuthStorage.create(); // default ~/.pi/agent/auth.json

  console.log("\n=== Tharvel · login OpenAI Codex (ChatGPT Plus/Pro) ===\n");

  await auth.login("openai-codex", {
    onAuth: ({ url, instructions }) => {
      console.log("Apri questo URL nel browser dove sei già loggato a ChatGPT:\n");
      console.log("  " + url + "\n");
      if (instructions) console.log(instructions + "\n");
      console.log("Se il callback automatico fallisce, paste-a qui sotto il codice ricevuto.\n");
    },
    onPrompt: async (p) => {
      const placeholder = p.placeholder ? ` (${p.placeholder})` : "";
      return ask(p.message + placeholder + ":");
    },
    onProgress: (m) => console.log("• " + m),
    onManualCodeInput: async () => {
      return ask("Codice OAuth (paste manuale, fallback se il callback non arriva):");
    },
  });

  console.log("\nLogin completato. Credenziali salvate in ~/.pi/agent/auth.json\n");
  console.log("Provider attivi:", auth.list().join(", "));
  rl.close();
}

main().catch((err) => {
  console.error("\nErrore login:", err.message || err);
  console.error("\nCause comuni:");
  console.error("  - State OAuth scaduto: completa il flow entro 2-3 minuti");
  console.error("  - Browser senza sessione ChatGPT attiva: usa il browser principale");
  console.error("  - Ad blocker/privacy che blocca callback localhost: prova paste manuale");
  console.error("  - Multiple tab/refresh: chiudi tutto e rilancia il comando da capo");
  process.exit(1);
});
