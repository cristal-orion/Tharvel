# Tharvel UI

Vue 3 + TypeScript + Vite. Accesso admin e cliente su `/tharveladmin`.

## Interfaccia mobile

Fino a 1100 px l'anteprima occupa lo schermo, con una barra compatta:

- Menu: siti e azioni admin, storico/ripristino, asset, tema, impostazioni e logout.
- Nome del sito: percorso, ricarica, nuova scheda e dimensioni dell'anteprima.
- Selettore: abilita un singolo tap sul sito; Annulla ripristina la navigazione normale.
- Pubblica: conferma delle modifiche pendenti.

La bubble della chat si trascina sui bordi e ricorda la posizione. Il pannello aperto
ha due altezze, selezionabili con i pulsanti o con uno swipe sulla maniglia.
La chiusura conserva bozza, allegati e conversazione finché la pagina rimane aperta.
L'iframe non viene rimontato aprendo chat o strumenti. Il cambio sito azzera il
contesto locale della chat per evitare di inviare contenuti al sito sbagliato.

`useMobileLayout.ts` e le media query condividono il breakpoint di 1100 px.
`useVisualViewport` mantiene visibili chat e dialoghi quando compare la tastiera.
Il desktop conserva le preferenze di larghezza e visibilità dei pannelli.

La selezione touch usa `server/preview-pointer.html`, inserito prima degli script
del sito anche negli HTML legacy. Il bridge verifica il parent, completa un handshake
e consuma il tap senza attivare il link/bottone selezionato. La UI accetta messaggi
soltanto dalla finestra e dall'origin dell'iframe corrente.

La chiusura della chat non chiude il WebSocket. Una reale disconnessione di rete
è diversa: il backend attuale non riproduce lo streaming perso; la UI segnala un
eventuale risultato parziale e ritenta la connessione, senza reinviare il prompt.

## Verifica locale

Dalla directory `tharvel`:

```sh
npm run build --workspace ui
npm run build --workspace server
npx playwright install --with-deps chromium webkit
npm run test:e2e --workspace ui
```

I test avviano Vite sulla porta 5187 e simulano API e WebSocket: non servono
credenziali e non modificano siti reali. Usano il bridge iframe effettivo e coprono
ruoli, chat/streaming, allegati, selezione touch e legacy, navigazione, strumenti,
pubblicazione, ridimensionamento e ingresso desktop su Chromium e WebKit.
Screenshot e trace si trovano in `test-results/` (esclusa da Git).

La tastiera è verificata simulando la geometria di `visualViewport`; per il collaudo
su dispositivi fisici verificare anche Safari iOS e Chrome Android con tastiera
aperta, barre del browser in movimento, notch, rotazione e passaggio in background.
