# Public Minecraft Bot Service

This version turns the original single-bot dashboard into a public multi-bot service.

## How it works

1. Open the website root (`/`).
2. Enter a public Minecraft server hostname/IP and port.
3. Optionally enter the Minecraft version; leave it blank for Mineflayer auto-detection.
4. The service generates a unique offline-mode username such as `Bot_A1B2C3D4`.
5. A separate worker process joins that server and stays connected using the existing AFK/reconnect/movement features.
6. The returned dashboard is `https://YOUR-DOMAIN/Bot_A1B2C3D4`.

Each bot has its own process and configuration, so one bot's reconnect loop does not share the Mineflayer instance of another bot.

## Environment variables

- `PORT` - web server port, default `5000`
- `MAX_ACTIVE_BOTS` - maximum active bot workers, default `10`
- `CREATE_COOLDOWN_MS` - minimum time between bot creations from one client IP, default `30000`

The service rejects obvious localhost/private-network targets to avoid turning the public form into an internal-network connector.

## Important deployment note

This service keeps the bot list in memory. Restarting the Node process removes the active bots and their dashboard records. For a production service, add persistent storage and authentication if you need durable accounts.

## Start

```bash
npm install
npm start
```

The public dashboard is served by `index.js`; `worker.js` contains the original Mineflayer bot logic.