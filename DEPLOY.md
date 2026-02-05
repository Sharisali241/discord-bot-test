# Deploy Discord Sound Bot on AWS EC2

This guide walks you through running the bot (and optional web dashboard) on an **Amazon EC2** instance.

---

## 1. Create an EC2 instance

1. In **AWS Console** → **EC2** → **Launch Instance**.
2. **Name:** e.g. `discord-sound-bot`.
3. **AMI:** Amazon Linux 2023 or **Ubuntu 22.04 LTS** (recommended).
4. **Instance type:** `t2.micro` (free tier) or `t3.micro` is enough.
5. **Key pair:** Create or select a `.pem` key and download it. You need this to SSH.
6. **Network / Security group:**
   - Allow **SSH (22)** from your IP (or anywhere for testing).
   - If you want the **web dashboard** from the internet: allow **TCP 3000** (or your `WEB_PORT`) from your IP or `0.0.0.0/0`.
7. **Storage:** 8 GB default is fine.
8. Launch the instance and note its **Public IP** (e.g. `3.110.123.45`).

---

## 2. Connect to the instance

From your local machine (PowerShell or terminal):

```bash
# Fix key permissions (Linux/Mac only; Windows usually skips this)
# chmod 400 your-key.pem

ssh -i "path/to/your-key.pem" ec2-user@PUBLIC_IP
# Ubuntu use: ssh -i "path/to/your-key.pem" ubuntu@PUBLIC_IP
```

Replace `PUBLIC_IP` with your instance’s public IP and `your-key.pem` with the key file path.

---

## 3. Install Node.js on the instance

**Amazon Linux 2023:**

```bash
sudo dnf install -y nodejs npm
node -v   # should be v18+
```

**Ubuntu 22.04:**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
npm -v
```

**FFmpeg** (used for audio; bot and web use it):

```bash
# Amazon Linux 2023
sudo dnf install -y ffmpeg

# Ubuntu
sudo apt-get update && sudo apt-get install -y ffmpeg
```

---

## 4. Upload your project to EC2

**Option A – Using Git (recommended)**

1. Push your project to **GitHub** (or GitLab).  
   - Do **not** commit `.env` or `node_modules` (they are in `.gitignore`).
2. On the EC2 instance:

```bash
cd ~
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git discord-bot
cd discord-bot
```

**Option B – Using SCP from your PC**

From **Windows (PowerShell)** on your machine (not on EC2):

```powershell
scp -i "path\to\your-key.pem" -r G:\discord-bot\* ec2-user@PUBLIC_IP:~/discord-bot/
# Ubuntu: use ubuntu@PUBLIC_IP
```

Then on the instance:

```bash
cd ~/discord-bot
```

---

## 5. Configure environment variables

On the EC2 instance:

```bash
cd ~/discord-bot   # or wherever you uploaded the project

# Create .env from example
cp .env.example .env

# Edit .env with nano (or vi)
nano .env
```

Set at least:

```env
DISCORD_TOKEN=your_actual_bot_token_here
PREFIX=!
```

If you want the web dashboard on a custom port:

```env
WEB_PORT=3000
```

Save and exit (in nano: `Ctrl+O`, Enter, `Ctrl+X`).

---

## 6. Install dependencies and test

```bash
npm install
npm start
```

You should see the bot log in. Press `Ctrl+C` to stop. If the web dashboard is needed:

```bash
npm run web
```

Again, `Ctrl+C` to stop. Next we make both run in the background.

---

## 7. Run the bot (and web) permanently with PM2

**PM2** keeps the Node process running and restarts it if it crashes.

```bash
# Install PM2 globally
sudo npm install -g pm2

# Start bot and web from the project folder
cd ~/discord-bot
pm2 start ecosystem.config.cjs

# To run only the Discord bot (no web dashboard):
# pm2 start index.js --name discord-bot

# Check status
pm2 status

# View logs
pm2 logs

# Restart after code/config changes
pm2 restart all
```

To have PM2 start the app on server reboot:

```bash
pm2 startup
# Run the command it prints (sudo ...)
pm2 save
```

**Useful PM2 commands:**

| Command        | Description              |
|----------------|--------------------------|
| `pm2 status`   | List processes           |
| `pm2 logs`     | Stream logs              |
| `pm2 restart all` | Restart bot + web    |
| `pm2 stop all` | Stop bot + web           |

---

## 8. (Optional) Run only the bot with systemd

If you prefer not to use PM2 and only run the Discord bot:

```bash
sudo nano /etc/systemd/system/discord-bot.service
```

Paste (adjust paths and user if needed):

```ini
[Unit]
Description=Discord Sound Bot
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/discord-bot
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

For Ubuntu, use `User=ubuntu` and `WorkingDirectory=/home/ubuntu/discord-bot`.

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable discord-bot
sudo systemctl start discord-bot
sudo systemctl status discord-bot
```

---

## 9. Open the web dashboard (if you use it)

- **Security group:** In AWS EC2 → Security Groups → your instance’s group → **Edit inbound rules** → Add rule: **Custom TCP**, port **3000** (or your `WEB_PORT`), source **My IP** or **0.0.0.0/0** (less secure).
- In the browser: `http://PUBLIC_IP:3000`

---

## 10. Summary checklist

- [ ] EC2 instance launched, key pair saved.
- [ ] SSH works: `ssh -i your-key.pem ec2-user@PUBLIC_IP` (or `ubuntu@...`).
- [ ] Node.js and FFmpeg installed.
- [ ] Project on instance (git clone or scp).
- [ ] `.env` created with `DISCORD_TOKEN` (and optional `PREFIX`, `WEB_PORT`).
- [ ] `npm install` run in project folder.
- [ ] Bot runs with `npm start` or `pm2 start ecosystem.config.cjs`.
- [ ] PM2: `pm2 startup` and `pm2 save` for restart on reboot.
- [ ] If using web: port 3000 open in security group; test `http://PUBLIC_IP:3000`.

---

## Troubleshooting

- **Bot doesn’t log in:** Check `DISCORD_TOKEN` in `.env`, no extra spaces. Check Discord Developer Portal: bot token is correct and **Message Content Intent** is enabled.
- **Web dashboard not loading:** Check security group allows TCP 3000 (or your port); run `npm run web` and then `pm2 logs`.
- **“Cannot find module”:** Run `npm install` again in the project directory.
- **FFmpeg / playback errors:** Install FFmpeg: `sudo dnf install -y ffmpeg` (Amazon Linux) or `sudo apt-get install -y ffmpeg` (Ubuntu).
