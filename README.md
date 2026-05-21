# Agar TCP/UDP JS

Mini progetto multiplayer ispirato ad **agar.io**, scritto in JavaScript con **Node.js**.

L'obiettivo didattico è mostrare una separazione realistica tra:

- **TCP (`node:net`)**: eventi affidabili e ordinati: join, chat, morte, respawn, classifica, errori.
- **UDP (`node:dgram`)**: input frequenti e snapshot del mondo in tempo reale, dove perdere un pacchetto non è grave perché arriva subito quello successivo.
- **Client browser + bridge Node.js**: i browser non espongono socket TCP/UDP raw. Per questo il client visuale Canvas parla in WebSocket con un piccolo bridge locale Node.js, e il bridge parla con il game server usando veri socket TCP/UDP.

## Requisiti

- Node.js 18+
- npm

## Installazione

```bash
cd agar-sockets-js
npm install
```

## Avvio rapido in locale

Terminale 1:

```bash
npm run server
```

Terminale 2:

```bash
npm run client
```

Poi apri:

```text
http://127.0.0.1:8080
```

Lascia host `127.0.0.1`, TCP `4000`, UDP `4001`, scegli un nickname e premi **Gioca**.


## Multiplayer locale

Il bridge client ora supporta **più sessioni indipendenti**: ogni tab del browser, finestra o dispositivo LAN che apre l'interfaccia ottiene un proprio player, con una propria connessione TCP e UDP verso il server.

### Stesso PC

1. Avvia server e client bridge.
2. Apri più tab su:

```text
http://127.0.0.1:8080
```

3. In ogni tab scegli un nickname/colore diverso e premi **Gioca**.

### Dispositivi sulla stessa rete LAN

Quando avvii `npm run client`, il bridge stampa anche gli URL LAN, per esempio:

```text
http://192.168.1.50:8080
```

Apri quell'URL dagli altri dispositivi collegati alla stessa rete. Se server e bridge girano sullo stesso PC, nel menu puoi lasciare:

```text
Host gioco: 127.0.0.1
TCP: 4000
UDP: 4001
```

Perché il browser parla col bridge, e il bridge parla col game server locale via TCP/UDP. Se invece ogni PC esegue il proprio bridge, imposta come host gioco l'IP del PC su cui gira il server.

## Configurazione via variabili d'ambiente

Server:

```bash
TCP_PORT=5000 UDP_PORT=5001 BOT_COUNT=32 npm run server
```

Client bridge:

```bash
UI_PORT=8090 npm run client
```

## Controlli

- Mouse: direzione/target
- Spazio: split
- W: spara pellet / eject mass
- F: alterna zoom follow classico e zoom più ampio
- Chat in basso: messaggi TCP

## Architettura

```text
Browser Canvas UI
      │ WebSocket locale /bridge
      ▼
Node.js Client Bridge
      │ una sessione per ogni tab/browser LAN
      │ TCP: join/chat/respawn/eventi affidabili
      │ UDP: hello/input/snapshot real-time
      ▼
Node.js Game Server
```

### Flusso di connessione

1. Ogni browser/tab apre una WebSocket verso il bridge locale/LAN (`/bridge`).
2. Il bridge apre una connessione TCP verso il server e invia:

```json
{ "type": "join", "name": "Blob", "color": "#4ecdc4" }
```

3. Il server risponde via TCP con `welcome`, contenente `id`, `token`, porta UDP e dimensioni del mondo.
4. Il bridge invia via UDP:

```json
{ "type": "hello", "id": "...", "token": "..." }
```

5. Da quel momento:
   - il client invia target/movimento via UDP;
   - il server invia snapshot del mondo via UDP;
   - chat, morte e respawn restano su TCP.

## Protocollo sintetico

### TCP client → server

- `join`: entra nell'arena.
- `chat`: invia messaggio chat.
- `respawn`: rientra dopo essere stato assorbito.
- `ping`: test affidabile.

### TCP server → client

- `welcome`: dati iniziali sessione.
- `udpReady`: handshake UDP completato.
- `chat`: messaggio chat globale.
- `system`: evento globale.
- `leaderboard`: classifica affidabile periodica.
- `dead`: il player è stato assorbito.
- `respawned`: respawn avvenuto.
- `error`: errore di protocollo.

### UDP client → server

- `hello`: associa l'endpoint UDP all'utente autenticato via token.
- `input`: target di movimento `{ tx, ty }`.
- `split`: split verso il target `{ tx, ty }`.
- `eject`: spara pellet/massa verso il target `{ tx, ty }`.

### UDP server → client

- `helloAck`: conferma handshake.
- `snapshot`: stato visibile del mondo: player/celle, food, pellet espulsi, classifica, coordinate.
- `error`: errore UDP.

## Gameplay implementato

- Mondo 2D con canvas.
- Celle/player circolari.
- Cibo colorato generato dal server.
- Crescita mangiando cibo.
- **Split con barra spaziatrice**: una cella abbastanza grande si divide e lancia metà massa verso il puntatore.
- **Eject mass con W**: spara pellet di massa nella direzione del puntatore, come nel gioco originale.
- Celle multiple per giocatore, con cooldown e ricombinazione dopo alcuni secondi.
- Assorbimento di altri player se si è abbastanza più grandi.
- Velocità inversamente proporzionale alla massa.
- Decadimento leggero della massa per bilanciare la partita.
- Bot server-side più numerosi, con IA migliorata: fuga dalle minacce, inseguimento delle prede, farming locale di food/pellet e split offensivo più selettivo.
- Collaborazione temporanea tra bot: un bot può donare pellet a un alleato durante una kill potenziale; dopo un po' uno dei due può tradire l'altro.
- Chat globale su TCP.
- Classifica live.
- Rendering client con smoothing/interpolazione per ridurre gli scatti tra snapshot UDP.
- Snapshot con margine extra: il server invia elementi oltre i bordi della visuale per evitare pop-in visibile, senza forzare la vista dell'intera mappa.

## File principali

```text
agar-sockets-js/
├─ package.json
├─ shared/
│  └─ config.js             # costanti e utility condivise
├─ server/
│  └─ server.js             # game server TCP + UDP
└─ client/
   ├─ client.js             # bridge locale WebSocket ⇄ TCP/UDP
   └─ public/
      └─ index.html         # interfaccia Canvas
```

## Note importanti

- Se giochi su macchine diverse, apri sul firewall sia la porta TCP sia la porta UDP.
- Su reti NAT/restrictive, UDP potrebbe essere filtrato: in quel caso il join TCP funziona ma non arrivano snapshot real-time.
- I pacchetti sono JSON per chiarezza didattica; in produzione conviene un formato binario più compatto.
- L'autenticazione UDP usa un token generato dopo il join TCP: è semplice, ma già evita che un client qualunque possa inviare input per un altro `id`.

## Possibili estensioni

- Virus verdi alimentabili con i pellet e meccaniche di team/virus split più vicine ad agar.io.
- Stanze multiple.
- Snapshot binari, delta compression e predizione client-side più avanzata.
- Lag compensation/interpolazione più avanzata.
- Persistenza punteggi con SQLite/PostgreSQL.
- Deploy con Docker e reverse proxy per il bridge web.
