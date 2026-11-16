# DocuSign server security setup

For OmniCloud **deployment administrators** and **developers**. End users never need any of this. Until the key is configured, Contracts → DocuSign Settings still shows the connection form, but Connect is disabled with the note "DocuSign connection is temporarily unavailable. Please contact your OmniCloud administrator."

## What it is

OmniCloud stores each user's DocuSign credentials encrypted (AES-256-GCM). The encryption key comes only from the server environment variable `DOCUSIGN_ENCRYPTION_KEY`. Without a valid key, DocuSign connections are disabled; OmniCloud never stores the credentials unencrypted.

- The key is 32 random bytes, written as base64 (44 characters) or as 64 hexadecimal characters.
- OmniCloud never creates, rotates or prints this key, in the browser or on startup.
- The key never appears in the UI or in any API response.

## Hosted deployment (one time per environment)

1. Generate a key on a trusted machine:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
2. Store it in the hosting platform's secret store and expose it to the app as `DOCUSIGN_ENCRYPTION_KEY`. Examples: an Azure Key Vault reference in Azure Container Apps, a Secrets Manager value injected into the ECS task, or an encrypted environment variable on Vercel.
3. Use a **different** key for staging and production.
4. Restart or redeploy the app. Connect to DocuSign then works for every user, with nothing to do on their own computers.

If the key is missing or invalid, the server logs one warning naming the variable (never its value):
`[DocuSign] Server security not configured: DOCUSIGN_ENCRYPTION_KEY is not set …`

### Keep the key stable

Credentials encrypted with a key can only be read with that same key. If the key changes, every user's saved DocuSign connection becomes unreadable, and each user has to click Connect again once. Rotate it only on purpose, and back it up in the secret store.

## Local development

1. Generate a key with the command above.
2. Add `DOCUSIGN_ENCRYPTION_KEY=<value>` to `.env.local` in the project root. `.gitignore` already excludes `.env*`, so it isn't committed.
3. Restart `next dev`.

The app never shows these steps in its UI. When the key is missing or invalid, the server log line above says so.
