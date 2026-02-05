#!/usr/bin/env bash
# Deploy Discord bot to AWS EC2 via SCP (run in Git Bash: bash deploy-ec2.sh)

# ----- EDIT THESE -----
KEY_PATH="D:/teamspeak-server/teamspeak-key.pem"
EC2_HOST="ubuntu@43.205.113.19"
REMOTE_DIR="~/discord-bot"
# ---------------------

set -e
cd "$(dirname "$0")"

echo "Uploading to $EC2_HOST ..."
tar --exclude='node_modules' --exclude='.env' --exclude='.git' -cf - . \
  | ssh -i "$KEY_PATH" -o StrictHostKeyChecking=accept-new "$EC2_HOST" "mkdir -p $REMOTE_DIR && cd $REMOTE_DIR && tar xf -"

echo "Done. On the server run: cd discord-bot && npm install && cp .env.example .env && nano .env && pm2 start ecosystem.config.cjs"
