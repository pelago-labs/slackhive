# WhatsApp Platform Integration

Connect a SlackHive agent to WhatsApp using the Meta WhatsApp Cloud API.

## Prerequisites

- A [Meta Developer account](https://developers.facebook.com/)
- A Meta App with the **WhatsApp** product added
- A WhatsApp Business Account with a test or production phone number
- SlackHive running and reachable via a public HTTPS URL (ngrok works for local dev)

---

## 1. Meta App Setup

1. Go to [developers.facebook.com](https://developers.facebook.com/) → **My Apps** → **Create App**.
2. Choose **Business** as the app type and complete setup.
3. On the app dashboard, click **Add Product** → **WhatsApp** → **Set Up**.
4. Under **WhatsApp → API Setup**, note down:
   - **Phone Number ID** — needed when creating the agent in SlackHive.
5. Generate a **Permanent Access Token** (System User token with `whatsapp_business_messaging` permission) and save it.

---

## 2. Environment Variable

Add the following to your `.env` (already done during `slackhive init`):

```env
WHATSAPP_WEBHOOK_VERIFY_TOKEN=slackhive-whatsapp-verify-2024
```

You can change this value, but it must match what you enter in the Meta webhook configuration.

Optionally, for payload signature verification:

```env
WHATSAPP_APP_SECRET=<your-meta-app-secret>
```

---

## 3. Webhook Configuration

The webhook endpoint is:

```
https://<your-domain>/api/webhooks/whatsapp
```

For local development with ngrok:

```bash
# Start SlackHive
slackhive start   # runs on http://localhost:3001

# In a separate terminal, expose it publicly
ngrok http 3001
```

Use the ngrok HTTPS URL as your base URL.

### Register the webhook in Meta

1. In your Meta App dashboard → **WhatsApp → Configuration**.
2. Under **Webhook**, click **Edit**.
3. Set **Callback URL** to `https://<ngrok-or-prod-url>/api/webhooks/whatsapp`.
4. Set **Verify Token** to the value in `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
5. Click **Verify and Save** — Meta will call the URL and check the challenge response.
6. After saving, click **Manage** next to Webhook fields and subscribe to the **messages** field.

---

## 4. Create a WhatsApp Agent in SlackHive

1. Open SlackHive UI → **New Agent**.
2. In Step 1 (Identity), select **WhatsApp** as the platform.
3. Follow the on-screen instructions in Step 2 (WhatsApp Setup).
4. In Step 3 (Credentials), fill in:
   - **Phone Number ID** — from Meta App → WhatsApp → API Setup.
   - **Access Token** — the permanent system user token.
   - **Webhook Verify Token** — must match `WHATSAPP_WEBHOOK_VERIFY_TOKEN` in `.env`.
5. Complete Step 4 (Personality) and click **Create Agent**.

---

## 5. How It Works

```
WhatsApp User
    │  sends message
    ▼
Meta WhatsApp Cloud API
    │  POST /api/webhooks/whatsapp
    ▼
SlackHive Web (Next.js)
    │  forwards entry to runner
    ▼
SlackHive Runner  →  WhatsAppAdapter  →  Agent LLM
    │  sends reply via graph.facebook.com
    ▼
WhatsApp User  ← reply
```

- Incoming messages are forwarded from the web process to the runner's internal `/whatsapp` endpoint.
- The runner matches the `phoneNumberId` in the payload to the correct `WhatsAppAdapter` instance.
- Conversation history is kept per sender phone number for multi-turn context.
- Outgoing messages are sent via `graph.facebook.com/v18.0/{phoneNumberId}/messages`.

---

## Troubleshooting

| Issue | Likely cause | Fix |
|---|---|---|
| Meta returns "Verification failed" | Wrong verify token or middleware blocking | Check `WHATSAPP_WEBHOOK_VERIFY_TOKEN` matches; ensure `/api/webhooks` is excluded from auth middleware |
| ngrok ERR_NGROK_334 | Previous ngrok session still running | `pkill -f ngrok` then restart |
| Web app crashes on `slackhive start` | Stale production build | Run `npx next build` in `apps/web` before starting |
| Messages not received | `messages` webhook field not subscribed | Meta dashboard → WhatsApp → Configuration → Webhook fields → tick **messages** |
