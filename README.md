# WhatsApp score bot

Tracks daily **Polderprikker** and **MapTap** scores in a WhatsApp group of friends and posts a
leaderboard every evening at 22:00 (Europe/Amsterdam), with a weekly summary on Sundays.

- Logs in as a *linked device* of a separate WhatsApp account (Baileys 7, no browser).
- Reads only the configured group and stores only score messages (SQLite).
- Commands in the group: `!stand` (today), `!week` (this week), `!weken` (last 6 weeks: top 3 per week,
  week wins, average day total), `!help`. It reacts to nothing else.
- Bot messages are in Dutch; code, logs and the CLI are in English.

**Points**
- Every game counts equally: `1000 / number of games` points each, so 500 now
  (Polderprikker ÷ 10, MapTap ÷ 2). A game you didn't play counts as 0.
- Day total = sum of those points, 0–1000. Week total = sum of the day totals.
- `!help` explains this in the group, generated from the registered games.

**Rules for scores**
- The day of a score is the Amsterdam date of the message.
- Only the first score per player per game per day counts.
- Old results that get posted again are ignored. That means a MapTap date that isn't today, or a Polderprikker number that already appeared on an earlier day.

## Local setup (WSL / Ubuntu)

You need Node.js 22 or newer. Production uses Node 26 LTS.

```bash
npm install
cp .env.example .env            # fill in WA_PHONE_NUMBER (the bot's number, digits only)
cp config.example.json config.json
npm test
npm run dev                     # or: npm run dry-run  (prints messages instead of sending)
```

### Linking the account

1. Set `WA_PHONE_NUMBER` in `.env` to the bot account's number, e.g. `31612345678`.
2. Start the bot. It logs an 8-character **pairing code**.
3. On the bot phone, open WhatsApp → *Settings → Linked devices → Link a device*, tap *Link with phone number instead* and enter the code.

If `WA_PHONE_NUMBER` is empty, or the code request fails, the bot prints a QR code to scan instead.

The login is stored in `./auth/`, so you only link once. Treat that folder like a password.

### Finding the group JID

After connecting, the bot logs every group it is in:

```
INFO: group "Spelletjes"   jid: "120363012345678901@g.us"
```

Put that JID in `.env` as `WA_GROUP_JID` and restart. Until then the bot ignores all messages.

### Names

Names come from each player's WhatsApp name (pushName). To override them, add aliases to `config.json`. A key can be a phone number, a `...@s.whatsapp.net` JID or a `...@lid` id. WhatsApp now hides phone numbers in groups behind LIDs, so check which id each player has with:

```bash
npm run cli -- players        # prod: node dist/cli.js players
```

### Other CLI commands

These work offline, without a WhatsApp connection:

```bash
npm run cli -- stand [YYYY-MM-DD]
npm run cli -- week [YYYY-MM-DD]
npm run cli -- parse < result.txt    # test a parser on a pasted result
npm run cli -- weken [YYYY-MM-DD]
npm run cli -- backup out.db
```

### Importing past scores from a chat export

In WhatsApp: open the group → ⋮ → *More → Export chat → Without media*. Then:

```bash
npm run cli -- import "WhatsApp Chat with <group>.txt"           # preview, stores nothing
npm run cli -- import "WhatsApp Chat with <group>.txt" --apply   # import
```

Only score messages are imported, with the same rules as live (first score per game per day,
no re-posted old results). Running it twice is safe. Export names are matched to players via
aliases, the WhatsApp names the bot has seen (also first name only), phone numbers, or as the
last remaining group member. Unmatched names are listed: add an alias with exactly that name.

On the VM (the export only needs to exist inside the container while importing):

```bash
docker compose cp chat.txt bot:/tmp/chat.txt
docker compose exec bot node dist/cli.js import /tmp/chat.txt            # then again with --apply
docker compose exec bot rm /tmp/chat.txt
```

## Deploying to the Oracle Cloud VM

These steps work on Ubuntu 24.04, on both the x86 `E2.1.Micro` and an arm64 A1 instance. The bot only makes outbound connections, so the only port you need open is SSH.

### 1. SSH in and add swap

This matters on the 1 GB VM: building the image can run out of memory without swap.

```bash
ssh -i ~/.ssh/oracle_key ubuntu@<VM_PUBLIC_IP>

sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

### 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && newgrp docker
docker compose version
```

### 3. Deploy

```bash
sudo mkdir -p /opt/whatsapp-score-bot && sudo chown ubuntu:ubuntu /opt/whatsapp-score-bot
git clone <your-repo-url> /opt/whatsapp-score-bot     # or: rsync -av --exclude node_modules ./ ubuntu@<IP>:/opt/whatsapp-score-bot/
cd /opt/whatsapp-score-bot
cp .env.example .env && nano .env             # WA_PHONE_NUMBER, WA_GROUP_JID
cp config.example.json config.json            # must exist before starting, or Docker creates a directory
mkdir -p auth data && sudo chown -R 1000:1000 auth data   # container user is uid 1000 (Oracle's ubuntu user is 1001)
docker compose up -d --build
```

If you copy an already-linked `auth/` folder from your laptop, run the `chown` again after copying.

### 4. Link the account the first time

```bash
docker compose logs -f
```

Wait for the pairing code banner, then enter it on the bot phone as described in [Linking the account](#linking-the-account).

If you didn't know the group JID yet, copy it from the logs, put it in `.env` and run `docker compose up -d`.

To update later: `git pull && docker compose up -d --build`.

### Alternative: systemd instead of Docker

```bash
curl -fsSL https://deb.nodesource.com/setup_26.x | sudo -E bash - && sudo apt-get install -y nodejs
cd /opt/whatsapp-score-bot && npm ci && npm run build && npm prune --omit=dev
mkdir -p auth data
sudo cp deploy/whatsapp-score-bot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now whatsapp-score-bot
journalctl -u whatsapp-score-bot -f           # the pairing code shows up here
```

### Backups

```bash
scripts/backup.sh                 # → ./backups/whatsapp-bot-<date>.tar.gz (DB + auth/), keeps 14
crontab -e                        # 0 4 * * * /opt/whatsapp-score-bot/scripts/backup.sh
scp ubuntu@<IP>:/opt/whatsapp-score-bot/backups/*.tar.gz .   # keep a copy off the VM
```

The tarball contains your WhatsApp login, so store it safely.

### If the bot gets logged out

WhatsApp unlinks the bot if you remove it under *Linked devices*, or if the bot phone has been offline for about 14 days.

When that happens, the bot logs a clear error and stops reconnecting:
- with systemd, it exits with code 78 and stays stopped;
- in Docker, it idles.

To relink:

```bash
docker compose down && rm -rf auth/* && docker compose up -d && docker compose logs -f
```

To avoid this, keep the prepaid SIM active and open WhatsApp on the bot phone now and then.

## Adding a new game

1. Create `src/games/<game>.ts` that exports a `GameParser`:

   ```ts
   export const wordle: GameParser = {
     id: 'wordle',            // stored in the DB, never change it
     name: 'Wordle',
     emoji: '🟩',
     maxScore: 6,             // used for the day total (score / max × points per game)
     parse(text) {
       const m = /Wordle\s+([\d.,]+)\s+([1-6X])\/6/i.exec(normalizeText(text));
       if (!m) return null;
       return { score: ..., maxScore: 6, puzzle: m[1] };   // puzzle or puzzleDate: rejects re-posts
     },
   };
   ```

2. Register it in `GAMES` in `src/games/index.ts`.
3. Add examples to `test/parsers.test.ts`, then run `npm test`.

You can check real messages with `npm run cli -- parse`.

Higher scores rank higher. For a game where lower is better, such as Wordle guesses, convert it in `parse`, e.g. `score = 7 - guesses`.

## Optional: daily winner joke

Set `ENABLE_JOKES=true` and `ANTHROPIC_API_KEY`. The 22:00 post then gets one dry line from `claude-haiku-5-5`.

Only scores are sent to the API. The winner appears as the placeholder `{winnaar}`, which the bot fills in locally, so no names or chat messages leave the machine.
