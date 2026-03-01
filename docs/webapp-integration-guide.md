# Webapp Integration Guide — New Runtime Capabilities

> **Target audience:** Next.js webapp developers integrating with the fractal-agents-runtime
> **Runtime branch:** `goal-40-hardware-key-encryption-server` (pending merge to `main`)
> **Last updated:** 2026-03-02

---

## Table of Contents

1. [Overview](#overview)
2. [Semantic Router Integration](#semantic-router-integration)
3. [Hardware Key Encryption Integration](#hardware-key-encryption-integration)
4. [Supabase Schema Reference](#supabase-schema-reference)
5. [API Endpoint Reference](#api-endpoint-reference)
6. [WebAuthn Client-Side Implementation](#webauthn-client-side-implementation)
7. [Agent Sync Changes](#agent-sync-changes)
8. [Environment Variables](#environment-variables)

---

## Overview

Two major capabilities have been added to the runtime:

| Capability | What It Does | Webapp Impact |
|------------|-------------|---------------|
| **Semantic Router** (Goal 42) | Dynamic LLM model routing — the runtime transparently routes LLM calls through a classification proxy that picks the optimal model per request | Minimal — deployment-level config. Webapp can optionally pass `model_name_override` per invocation |
| **Hardware Key Encryption** (Goal 40) | WebAuthn/FIDO2 hardware key registration, assertion verification, asset protection policies, and client-side encrypted data storage | Significant — webapp needs WebAuthn UI, key management pages, policy configuration, and encrypted data flows |

---

## Semantic Router Integration

### How It Works

The semantic router is a **transparent proxy** between the runtime and LLM providers. When enabled, all LLM calls go through the router, which classifies each request and routes it to the optimal model (e.g., simple chat → `gpt-4o-mini`, complex extraction → `gpt-4o`).

```text
Webapp → Agent Runtime → Semantic Router (Envoy + Go) → LLM Provider
```

The runtime's shared LLM factory (`graphs/llm.py`) handles this transparently via environment variables. **No per-assistant changes are needed.**

### What the Webapp Needs to Do

#### 1. Nothing Required for Basic Operation

When `SEMANTIC_ROUTER_ENABLED=true` is set on the runtime container, all LLM calls are automatically routed. The webapp doesn't need any code changes for this to work.

#### 2. Optional: Per-Invocation Model Override

The webapp can override the model for a specific run invocation by passing `model_name_override` in the configurable. The primary use case is **pinning a vision-capable model when the user sends image content**, since the router's BERT classifier works on text embeddings and cannot auto-detect `image_url` blocks:

```typescript
// Helper: detect if user message contains image content
function hasImageContent(messages: Message[]): boolean {
  return messages.some((msg) =>
    Array.isArray(msg.content)
      ? msg.content.some((block) => block.type === "image_url")
      : false
  );
}

// When creating a run via the LangGraph SDK
const messages = [{ role: "human", content: userMessage }];

const result = await client.runs.create(threadId, assistantId, {
  input: { messages },
  config: {
    configurable: {
      // Pin a vision-capable model when the user sends images.
      // Without this, the router sends image messages to a non-vision
      // model (e.g. gpt-4.1) which will fail or produce poor results.
      ...(hasImageContent(messages) && {
        model_name_override: "gpt-4o",  // or "gpt-4o-mini" for lower cost
      }),
    },
  },
});
```

**Resolution order** (highest priority first):
1. `configurable.model_name_override` (per-invocation, set by webapp/API caller — e.g., vision pinning)
2. `SEMANTIC_ROUTER_MODEL` env var (deployment-level, e.g., `"MoM"`)
3. `custom_model_name` (assistant-level, for custom endpoints)
4. `model_name` (assistant-level default, e.g., `"openai:gpt-4.1"`)

> **When to use `model_name_override`:**
> - **Image inputs** → pin `gpt-4o` or `gpt-4o-mini` (vision-capable)
> - **Force a specific model** → e.g., `gpt-5.2` for a complex task regardless of router classification
> - **Most requests** → leave unset and let the router classify automatically

#### 3. Optional: Routing Metadata Headers

The runtime can forward metadata headers to the router for more intelligent routing decisions. These are set programmatically in the graph code, not by the webapp. But if you want to expose routing hints from the UI:

```typescript
// Future: if the webapp wants to influence routing
config: {
  configurable: {
    routing_metadata: {
      "x-sr-org-id": organizationId,
      "x-sr-task-type": "extraction",  // hint: extraction, chat, analysis, classification
    },
  },
}
```

> **Note:** `routing_metadata` is not yet read from configurable — it's currently set in the graph code. This is a future enhancement if the webapp needs to influence routing.

#### 4. Semantic Router Dev Stack (Local Development)

For local development with the semantic router:

```bash
# Start the semantic router container
docker compose -f docker-compose.semantic-router.yml up -d

# First boot downloads ~1.5GB of BERT models (5-30 min)
# Subsequent starts: ~30 seconds (models cached in Docker volume)

# Set runtime env vars
export SEMANTIC_ROUTER_ENABLED=true
export SEMANTIC_ROUTER_URL=http://localhost:8801/v1
export SEMANTIC_ROUTER_MODEL=MoM
```

Dashboard available at `http://localhost:8700` — shows routing decisions, request history, and metrics.

### Semantic Router Config Reference

The router config lives at `config/semantic-router/config.yaml` in the runtime repo. Current routing rules (Phase B — cloud + local vLLM + cluster vLLM):

**Default routing decisions (automatic via BERT classifier):**

| Priority | Domain | Model | Backend | Rationale |
|----------|--------|-------|---------|-----------|
| 300 | `ocr` | `ais-ocr` | Local vLLM (DeepSeek OCR) | Specialized vision model for document image-to-text |
| 200 | `extraction` | `ministral-3b-instruct` | Cluster vLLM (AKS) | Fast structured JSON output, self-hosted |
| 200 | `classification` | `ministral-3b-instruct` | Cluster vLLM (AKS) | Fast labeling/categorization, self-hosted |
| 150 | `analysis` | `gpt-5.2` | OpenAI cloud | Newest, most capable — deep reasoning, multi-step tasks |
| 100 | `chat` | `gpt-4.1` | OpenAI cloud | Agentic mid-tier, good balance of capability and cost |
| 50 | `other` (fallback) | `gpt-4.1` | OpenAI cloud | Safe agentic default |

**Available for explicit pinning (not in default routing):**

| Model | Backend | Use Case |
|-------|---------|----------|
| `gpt-4o` | OpenAI cloud | Vision-capable — for image inputs in chat |
| `gpt-4o-mini` | OpenAI cloud | Cheaper vision — for lower-cost image inputs |
| `gpt-5.2-mini` | OpenAI cloud | Fast agentic — if available at OpenAI API |

> **Image inputs:** The BERT classifier works on text embeddings and cannot auto-detect `image_url` blocks in messages. When the webapp sends image content, it **must** explicitly set `model_name_override: "gpt-4o"` (or `"gpt-4o-mini"`) in the configurable to route to a vision-capable model. Without this, the router will send image messages to a non-vision model and the request will fail or produce poor results.

---

## Hardware Key Encryption Integration

### Architecture Overview

```text
┌──────────────────────────────────────────────────────────────┐
│  Next.js Webapp                                              │
│                                                              │
│  1. WebAuthn Registration (navigator.credentials.create)     │
│     → POST /keys/register (runtime API)                      │
│                                                              │
│  2. WebAuthn Assertion (navigator.credentials.get)           │
│     → POST /keys/assertions (runtime API)                    │
│                                                              │
│  3. Client-Side Encryption (Web Crypto API)                  │
│     → POST /keys/encrypted-data (runtime API)                │
│                                                              │
│  4. Key-Gated Retrieval                                      │
│     → GET /keys/encrypted-data/:id (428 → assertion → 200)   │
└──────────────┬───────────────────────────────────────────────┘
               │ HTTP + JWT (Authorization: Bearer <supabase-jwt>)
               ▼
┌──────────────────────────────────────────────────────────────┐
│  Agent Runtime (Python or TypeScript)                        │
│                                                              │
│  /keys/* routes — 18 endpoints                               │
│  hardware_key_service + encryption_service                   │
│  Direct Postgres (asyncpg / Bun.sql) — NOT PostgREST         │
└──────────────┬───────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────┐
│  Supabase Postgres                                           │
│                                                              │
│  hardware_keys         — WebAuthn credential storage         │
│  key_assertions        — Ephemeral proof-of-presence         │
│  totp_assertions       — TOTP-based proof-of-presence        │
│  asset_key_policies    — Per-asset protection rules          │
│  encrypted_asset_data  — Client-encrypted ciphertext         │
│                                                              │
│  All tables have RLS: user_id = auth.uid()                   │
└──────────────────────────────────────────────────────────────┘
```

**Important:** The `/keys/*` endpoints are served by the **runtime** (Robyn/Bun HTTP server), NOT by Supabase PostgREST. The webapp must call the runtime URL, not the Supabase URL, for these endpoints.

### Webapp Components Needed

#### 1. Key Management UI

A settings page (e.g., `/settings/security/hardware-keys`) where users can:

- **Register** a new hardware key (WebAuthn registration ceremony)
- **List** their registered keys with metadata (name, type, last used)
- **Rename** a key (friendly name update)
- **Deactivate** a key (soft-disable, not delete)

#### 2. Key Assertion Challenge Modal

A modal/dialog that triggers when a protected action requires hardware key verification:

- Runtime returns **HTTP 428 Precondition Required** with a JSON body describing what's needed
- Webapp shows the challenge UI
- User touches their hardware key
- Webapp records the assertion via the runtime API
- Webapp retries the original request

#### 3. Policy Configuration UI

An admin UI for setting protection policies on assets:

- "Require hardware key for decrypt/delete/export/share on this repository"
- Configurable `required_key_count` (1 = standard, 2+ = multi-key)
- Configurable `challenge_type`: `hardware_key`, `totp`, or `any`

#### 4. Encrypted Data Viewer

For assets that have encrypted payloads:

- Show metadata (algorithm, authorized keys)
- Trigger decryption flow (assertion → retrieve → client-side decrypt)
- Key rotation UI (add/remove authorized keys)

---

## Supabase Schema Reference

### `hardware_keys` Table

Stores WebAuthn/FIDO2 credential registrations. Private key never leaves the hardware device.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `uuid` | Primary key |
| `user_id` | `uuid` | FK → `auth.users.id` |
| `credential_id` | `text` | WebAuthn credential ID (base64url). Globally unique. |
| `public_key` | `bytea` | COSE-encoded public key for server-side assertion verification |
| `counter` | `bigint` | Signature counter (detects cloned keys — should only increase) |
| `transports` | `text[]` | Supported transports: `usb`, `ble`, `nfc`, `internal`, `hybrid` |
| `friendly_name` | `text` | User-defined name (e.g., "Blue SoloKey", "Backup YubiKey") |
| `device_type` | `text` | `solokey`, `yubikey`, `titan`, `nitrokey`, `onlykey`, `trezor`, `ledger`, `platform`, `other` |
| `attestation_format` | `text` | WebAuthn attestation format (`packed`, `tpm`, `none`, etc.) |
| `aaguid` | `text` | Authenticator Attestation GUID — identifies authenticator model |
| `is_active` | `boolean` | Whether key can be used for assertions (default: `true`) |
| `last_used_at` | `timestamptz` | Last successful assertion timestamp |
| `created_at` | `timestamptz` | Registration timestamp |
| `updated_at` | `timestamptz` | Last modification timestamp |

**RLS:** `user_id = auth.uid()` — users only see their own keys.

### `key_assertions` Table

Ephemeral proof-of-presence records. Short-lived (5 min TTL). Written after WebAuthn assertion verification.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `uuid` | Primary key |
| `user_id` | `uuid` | FK → `auth.users.id` |
| `hardware_key_id` | `uuid` | FK → `hardware_keys.id` |
| `asset_type` | `text` | Target asset type (nullable — `NULL` = general auth assertion) |
| `asset_id` | `uuid` | Target asset UUID (nullable) |
| `challenge` | `text` | The signed WebAuthn challenge (replay prevention + audit) |
| `verified_at` | `timestamptz` | When the assertion was cryptographically verified |
| `expires_at` | `timestamptz` | Default: `verified_at + 5 minutes` |
| `consumed` | `boolean` | Whether used by a protected operation (single-use) |
| `consumed_at` | `timestamptz` | When consumed |

**RLS:** `user_id = auth.uid()`

**Auto-cleanup:** `pg_cron` job runs every 15 minutes to delete expired assertions (`expires_at < now()`).

### `totp_assertions` Table

Same pattern as `key_assertions` but for TOTP authenticator app verification. 15-minute TTL (longer than hardware keys because TOTP codes rotate every 30s).

| Column | Type | Description |
|--------|------|-------------|
| `id` | `uuid` | Primary key |
| `user_id` | `uuid` | FK → `auth.users.id` |
| `factor_id` | `uuid` | Supabase MFA factor ID (from `auth.mfa_factors`) |
| `asset_type` | `text` | Target asset type (nullable) |
| `asset_id` | `uuid` | Target asset UUID (nullable) |
| `verified_at` | `timestamptz` | Verification timestamp |
| `expires_at` | `timestamptz` | Default: `verified_at + 15 minutes` |
| `consumed` | `boolean` | Single-use flag |
| `consumed_at` | `timestamptz` | When consumed |

**RLS:** `user_id = auth.uid()`

### `asset_key_policies` Table

Declares which assets require a challenge (hardware key, TOTP, or either) for which operations.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `uuid` | Primary key |
| `asset_type` | `text` | `repository`, `project`, `document`, `document_artifact`, `chat_session`, `agent`, `ontology`, `processing_profile`, `ai_engine` |
| `asset_id` | `uuid` | UUID of the protected asset (polymorphic) |
| `protected_action` | `text` | `decrypt`, `delete`, `export`, `share`, `sign`, `all_writes`, `admin` |
| `challenge_type` | `text` | `hardware_key`, `totp`, `any` (default: `hardware_key`) |
| `required_key_count` | `integer` | Number of distinct challenges required (default: 1, multi-key: 2+) |
| `required_key_ids` | `uuid[]` | If set, only these specific keys are accepted. `NULL` = any active key. |
| `created_by_user_id` | `uuid` | Audit trail |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | |

**RLS:** Read access follows `resource_permissions` pattern. Policies are visible to users who have access to the protected asset.

**No policy = no challenge required.** The system is opt-in per asset+action.

### `encrypted_asset_data` Table

Client-side encrypted payloads. The server **never sees plaintext** — encryption/decryption happens entirely in the browser using Web Crypto API.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `uuid` | Primary key |
| `asset_type` | `text` | Same enum as `asset_key_policies` |
| `asset_id` | `uuid` | The asset this encrypted data belongs to |
| `encrypted_payload` | `bytea` | Ciphertext (encrypted client-side) |
| `encryption_algorithm` | `text` | `AES-GCM-256` (default), `AES-CBC-256`, `ChaCha20-Poly1305` |
| `key_derivation_method` | `text` | `webauthn-prf-hkdf` (default), `webauthn-hmac-secret-hkdf`, `passphrase-pbkdf2`, `shamir-recombine` |
| `initialization_vector` | `bytea` | IV/nonce for the cipher (must be unique per encryption) |
| `authorized_key_ids` | `uuid[]` | Hardware key IDs whose PRF output can derive the decryption key |
| `encrypted_by_user_id` | `uuid` | Who encrypted this data |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | |

**RLS:** `encrypted_by_user_id = auth.uid()` for owner access; authorized key holders can also access via the key-gated retrieval flow.

---

## API Endpoint Reference

All endpoints require JWT authentication via `Authorization: Bearer <supabase-jwt>`.
Base URL: the runtime URL (e.g., `http://localhost:2024` or the k8s service URL).

### Hardware Key CRUD

| Method | Path | Description | Request Body | Response |
|--------|------|-------------|-------------|----------|
| `POST` | `/keys/register` | Register a new hardware key | `HardwareKeyRegistration` | `201` + `HardwareKeyResponse` |
| `GET` | `/keys/` | List user's hardware keys | — (query: `?device_type=`, `?is_active=`) | `200` + `HardwareKeyResponse[]` |
| `GET` | `/keys/:key_id` | Get a specific key | — | `200` + `HardwareKeyResponse` |
| `PATCH` | `/keys/:key_id` | Update key metadata | `HardwareKeyUpdate` | `200` + `HardwareKeyResponse` |
| `POST` | `/keys/:key_id/deactivate` | Deactivate a key | — | `200` + `HardwareKeyResponse` |

#### `HardwareKeyRegistration` (POST /keys/register)

```typescript
interface HardwareKeyRegistration {
  credential_id: string;        // base64url-encoded WebAuthn credential ID
  public_key: string;           // base64-encoded COSE public key
  counter: number;              // initial signature counter (usually 0)
  transports?: string[];        // ["usb", "ble", "nfc", "internal", "hybrid"]
  friendly_name?: string;       // "My Blue SoloKey"
  device_type?: string;         // "solokey" | "yubikey" | "titan" | ... | "other"
  attestation_format?: string;  // "packed" | "tpm" | "none" | ...
  aaguid?: string;              // authenticator model GUID
}
```

#### `HardwareKeyUpdate` (PATCH /keys/:key_id)

```typescript
interface HardwareKeyUpdate {
  friendly_name?: string;
  device_type?: string;
}
```

#### `HardwareKeyResponse`

```typescript
interface HardwareKeyResponse {
  id: string;                    // uuid
  user_id: string;               // uuid
  credential_id: string;         // base64url
  counter: number;
  transports: string[];
  friendly_name: string | null;
  device_type: string | null;
  attestation_format: string | null;
  aaguid: string | null;
  is_active: boolean;
  last_used_at: string | null;   // ISO 8601
  created_at: string;            // ISO 8601
  updated_at: string;            // ISO 8601
}
```

### Assertion Management

| Method | Path | Description | Request Body | Response |
|--------|------|-------------|-------------|----------|
| `POST` | `/keys/assertions` | Record a verified assertion | `AssertionRecord` | `201` + `AssertionResponse` |
| `GET` | `/keys/assertions` | List valid (unexpired, unconsumed) assertions | — (query: `?asset_type=`, `?asset_id=`) | `200` + `AssertionResponse[]` |
| `GET` | `/keys/assertions/status` | Check if a valid assertion exists for an asset | — (query: `?asset_type=`, `?asset_id=`) | `200` + `{ has_valid_assertion, assertion_id?, expires_at? }` |
| `POST` | `/keys/assertions/:assertion_id/consume` | Consume (use) an assertion | — | `200` + `AssertionResponse` |

#### `AssertionRecord` (POST /keys/assertions)

```typescript
interface AssertionRecord {
  hardware_key_id: string;       // uuid of the key that signed the assertion
  challenge: string;             // the WebAuthn challenge that was signed
  asset_type?: string;           // optional: scope assertion to a specific asset
  asset_id?: string;             // optional: scope assertion to a specific asset
  expires_in_seconds?: number;   // optional: custom TTL (default: 300 = 5 min)
}
```

#### `AssertionResponse`

```typescript
interface AssertionResponse {
  id: string;                    // uuid
  user_id: string;
  hardware_key_id: string;
  asset_type: string | null;
  asset_id: string | null;
  challenge: string;
  verified_at: string;           // ISO 8601
  expires_at: string;            // ISO 8601
  consumed: boolean;
  consumed_at: string | null;
}
```

### Asset Key Policies

| Method | Path | Description | Request Body | Response |
|--------|------|-------------|-------------|----------|
| `POST` | `/keys/policies` | Create a protection policy | `AssetKeyPolicyCreate` | `201` + `AssetKeyPolicyResponse` |
| `GET` | `/keys/policies` | List policies | — (query: `?asset_type=`, `?asset_id=`) | `200` + `AssetKeyPolicyResponse[]` |
| `GET` | `/keys/policies/:policy_id` | Get a specific policy | — | `200` + `AssetKeyPolicyResponse` |
| `DELETE` | `/keys/policies/:policy_id` | Delete a policy | — | `200` + `{ message }` |

#### `AssetKeyPolicyCreate` (POST /keys/policies)

```typescript
interface AssetKeyPolicyCreate {
  asset_type: string;            // "repository" | "project" | "document" | ...
  asset_id: string;              // uuid of the asset to protect
  protected_action: string;      // "decrypt" | "delete" | "export" | "share" | "sign" | "all_writes" | "admin"
  challenge_type?: string;       // "hardware_key" (default) | "totp" | "any"
  required_key_count?: number;   // default: 1
  required_key_ids?: string[];   // optional: restrict to specific key UUIDs
}
```

### Encrypted Asset Data

| Method | Path | Description | Request Body | Response |
|--------|------|-------------|-------------|----------|
| `POST` | `/keys/encrypted-data` | Store encrypted payload | `EncryptedAssetStore` | `201` + `EncryptedAssetResponse` |
| `GET` | `/keys/encrypted-data/:data_id` | Get encrypted data (key-gated) | — | `200` + `KeyGatedRetrievalResult` or `428` |
| `GET` | `/keys/encrypted-data` | List encrypted data metadata | — (query: `?asset_type=`, `?asset_id=`) | `200` + `EncryptedAssetMetadata[]` |
| `DELETE` | `/keys/encrypted-data/:data_id` | Delete encrypted data | — | `200` + `{ message }` |
| `PATCH` | `/keys/encrypted-data/:data_id/authorized-keys` | Rotate authorized keys | `EncryptedAssetKeyUpdate` | `200` + `EncryptedAssetResponse` |

#### `EncryptedAssetStore` (POST /keys/encrypted-data)

```typescript
interface EncryptedAssetStore {
  asset_type: string;
  asset_id: string;
  encrypted_payload: string;           // base64-encoded ciphertext
  encryption_algorithm?: string;       // "AES-GCM-256" (default) | "AES-CBC-256" | "ChaCha20-Poly1305"
  key_derivation_method?: string;      // "webauthn-prf-hkdf" (default) | ...
  initialization_vector: string;       // base64-encoded IV/nonce
  authorized_key_ids: string[];        // uuid[] — which hardware keys can decrypt
}
```

#### Key-Gated Retrieval Flow (GET /keys/encrypted-data/:data_id)

This is the core security flow. The endpoint checks if the user has a valid, unconsumed assertion from an authorized hardware key:

**Happy path (assertion exists):**
```
GET /keys/encrypted-data/:id → 200 + { encrypted_payload, iv, algorithm, ... }
```

**Challenge required (no assertion):**
```
GET /keys/encrypted-data/:id → 428 Precondition Required
{
  "error": "key_assertion_required",
  "message": "A valid hardware key assertion is required to access this encrypted data.",
  "required_key_ids": ["uuid-1", "uuid-2"],
  "required_key_count": 1,
  "asset_type": "document",
  "asset_id": "uuid-of-document"
}
```

**Webapp flow for 428:**
1. Parse the 428 response body
2. Show a challenge modal: "Touch your hardware key to access this data"
3. Trigger `navigator.credentials.get()` with the appropriate challenge
4. `POST /keys/assertions` with the signed assertion
5. Retry the original `GET /keys/encrypted-data/:id` request → now returns 200

---

## WebAuthn Client-Side Implementation

### Key Registration Flow

```typescript
// 1. Generate registration options (client-side)
const registrationOptions: PublicKeyCredentialCreationOptions = {
  challenge: crypto.getRandomValues(new Uint8Array(32)),
  rp: {
    name: "ImmoFlow Platform",
    id: window.location.hostname,  // e.g., "app.immoflow.de"
  },
  user: {
    id: new TextEncoder().encode(userId),  // Supabase user UUID
    name: userEmail,
    displayName: userFullName,
  },
  pubKeyCredParams: [
    { alg: -7, type: "public-key" },   // ES256 (ECDSA w/ SHA-256)
    { alg: -257, type: "public-key" }, // RS256 (RSASSA-PKCS1-v1_5 w/ SHA-256)
  ],
  authenticatorSelection: {
    authenticatorAttachment: "cross-platform",  // external hardware keys
    userVerification: "discouraged",             // key presence is enough
    residentKey: "discouraged",
  },
  attestation: "direct",  // request attestation statement
  timeout: 60000,
};

// 2. Call WebAuthn API
const credential = await navigator.credentials.create({
  publicKey: registrationOptions,
}) as PublicKeyCredential;

const response = credential.response as AuthenticatorAttestationResponse;

// 3. Extract and encode credential data
const credentialId = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');  // base64url

const publicKey = btoa(String.fromCharCode(...new Uint8Array(response.getPublicKey()!)));

// 4. Register with runtime API
const result = await fetch(`${RUNTIME_URL}/keys/register`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${supabaseAccessToken}`,
  },
  body: JSON.stringify({
    credential_id: credentialId,
    public_key: publicKey,
    counter: 0,
    transports: credential.response.getTransports?.() ?? [],
    friendly_name: userProvidedName,  // from UI input
    device_type: detectedDeviceType,   // from AAGUID lookup or user selection
    attestation_format: "packed",      // from attestation statement
    aaguid: extractAaguid(response.getAuthenticatorData()),
  }),
});
```

### Key Assertion Flow

```typescript
// 1. Generate assertion challenge
const challenge = crypto.getRandomValues(new Uint8Array(32));
const challengeBase64 = btoa(String.fromCharCode(...challenge));

// 2. Get user's registered key credential IDs
const keysResponse = await fetch(`${RUNTIME_URL}/keys/`, {
  headers: { "Authorization": `Bearer ${supabaseAccessToken}` },
});
const keys = await keysResponse.json();

// 3. Build allowCredentials list
const allowCredentials = keys
  .filter((k: HardwareKeyResponse) => k.is_active)
  .map((k: HardwareKeyResponse) => ({
    id: base64urlToBuffer(k.credential_id),
    type: "public-key" as const,
    transports: k.transports as AuthenticatorTransport[],
  }));

// 4. Trigger WebAuthn assertion
const assertion = await navigator.credentials.get({
  publicKey: {
    challenge,
    allowCredentials,
    userVerification: "discouraged",
    timeout: 60000,
  },
}) as PublicKeyCredential;

// 5. Find which key was used (match credential ID)
const usedKeyId = keys.find(
  (k: HardwareKeyResponse) => k.credential_id === bufferToBase64url(assertion.rawId)
)?.id;

// 6. Record assertion with runtime
const assertionResult = await fetch(`${RUNTIME_URL}/keys/assertions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${supabaseAccessToken}`,
  },
  body: JSON.stringify({
    hardware_key_id: usedKeyId,
    challenge: challengeBase64,
    asset_type: targetAssetType,   // optional: scope to specific asset
    asset_id: targetAssetId,       // optional
  }),
});
```

### Client-Side Encryption Flow

```typescript
// 1. After successful assertion, derive encryption key from PRF output
//    (PRF extension — supported by newer authenticators)

// 2. Generate a random AES-GCM key
const aesKey = await crypto.subtle.generateKey(
  { name: "AES-GCM", length: 256 },
  true,  // extractable for key wrapping
  ["encrypt", "decrypt"],
);

// 3. Encrypt the payload
const iv = crypto.getRandomValues(new Uint8Array(12));  // 96-bit IV for AES-GCM
const plaintext = new TextEncoder().encode(sensitiveData);

const ciphertext = await crypto.subtle.encrypt(
  { name: "AES-GCM", iv },
  aesKey,
  plaintext,
);

// 4. Store encrypted data via runtime API
await fetch(`${RUNTIME_URL}/keys/encrypted-data`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${supabaseAccessToken}`,
  },
  body: JSON.stringify({
    asset_type: "document",
    asset_id: documentId,
    encrypted_payload: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
    encryption_algorithm: "AES-GCM-256",
    key_derivation_method: "webauthn-prf-hkdf",
    initialization_vector: btoa(String.fromCharCode(...iv)),
    authorized_key_ids: [usedKeyId],  // which keys can decrypt
  }),
});
```

### Handling 428 Precondition Required

```typescript
async function fetchWithKeyChallenge<T>(
  url: string,
  options: RequestInit,
): Promise<T> {
  const response = await fetch(url, options);

  if (response.status === 428) {
    const challenge = await response.json();
    // challenge = {
    //   error: "key_assertion_required",
    //   required_key_ids: ["uuid-1"],
    //   required_key_count: 1,
    //   asset_type: "document",
    //   asset_id: "uuid"
    // }

    // Show challenge modal to user
    const assertion = await showHardwareKeyChallenge(challenge);

    // Record assertion
    await recordAssertion(assertion, challenge.asset_type, challenge.asset_id);

    // Retry original request
    const retryResponse = await fetch(url, options);
    if (!retryResponse.ok) {
      throw new Error(`Request failed after assertion: ${retryResponse.status}`);
    }
    return retryResponse.json();
  }

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json();
}
```

---

## Agent Sync Changes

### `syncAgentToLangGraph()` — What Changed

The existing `syncAgentToLangGraph()` function in the webapp already handles:

- `model_name` → set from `ai_models.runtime_model_name`
- `base_url` → set from `ai_model_endpoints.endpoint_url` (if custom endpoint)
- `custom_api_key` → set from `ai_model_endpoints.api_key_encrypted` (decrypted)

**New capability** — the runtime now supports these additional configurable fields:

| Field | Where Set | Purpose |
|-------|-----------|---------|
| `model_name_override` | Per-invocation (run-time) | Override model for this specific request |
| `routing_metadata` | Per-invocation (run-time) | HTTP headers forwarded to the LLM endpoint |

These are **not** set during agent sync — they're set per-invocation when creating a run. The agent sync flow does not need changes for the semantic router.

### Hardware Keys — No Agent Sync Impact

Hardware key endpoints are standalone API routes on the runtime. They don't go through the LangGraph assistant/run flow. The webapp calls them directly as REST endpoints.

---

## Environment Variables

### Runtime Environment Variables (New)

| Variable | Default | Description |
|----------|---------|-------------|
| `SEMANTIC_ROUTER_ENABLED` | `"false"` | Master toggle for semantic router mode |
| `SEMANTIC_ROUTER_URL` | (none) | Router proxy URL (e.g., `http://semantic-router:8801/v1`) |
| `SEMANTIC_ROUTER_MODEL` | `"MoM"` | Model name to send to the router (Mixture of Models) |
| `LANGFUSE_PROMPT_CACHE_TTL` | `300` | Langfuse prompt cache TTL in seconds (0 = disable cache) |

### Webapp Environment Variables (No Changes)

The webapp doesn't need new environment variables for these features. It calls the runtime API using the existing `LANGGRAPH_API_URL` (or `langgraph_runtimes.runtime_url` from the database).

---

## Error Codes Reference

### Hardware Key Error Responses

| HTTP Status | Error | When |
|-------------|-------|------|
| `400` | `ValidationError` | Invalid request body (missing/wrong fields) |
| `400` | `InvalidInputError` | Invalid `device_type`, `asset_type`, `protected_action`, etc. |
| `401` | `AuthenticationError` | Missing or invalid JWT |
| `404` | `HardwareKeyNotFoundError` | Key UUID doesn't exist or belongs to another user |
| `404` | `AssertionNotFoundError` | Assertion UUID doesn't exist |
| `404` | `EncryptedAssetNotFoundError` | Encrypted data UUID doesn't exist |
| `409` | `HardwareKeyConflictError` | `credential_id` already registered |
| `409` | `PolicyConflictError` | Policy already exists for this `asset_type + asset_id + protected_action` |
| `410` | `AssertionConsumedError` | Assertion already consumed (single-use) |
| `410` | `AssertionExpiredError` | Assertion has expired (past `expires_at`) |
| `428` | `KeyAssertionRequired` | A valid hardware key assertion is required (key-gated access) |

### Semantic Router (No Webapp-Visible Errors)

The semantic router is transparent to the webapp. If the router is down, the runtime logs warnings but falls back to direct LLM calls (if `SEMANTIC_ROUTER_URL` is unreachable, `ChatOpenAI` connects directly).

---

## Quick Reference: What to Build in the Webapp

### Priority 1: Hardware Key Management (Settings Page)

- [ ] `/settings/security/hardware-keys` — List registered keys
- [ ] Register key button → WebAuthn registration ceremony → `POST /keys/register`
- [ ] Rename key → `PATCH /keys/:id`
- [ ] Deactivate key → `POST /keys/:id/deactivate`
- [ ] Key details view (last used, device type, transports)

### Priority 2: Hardware Key Challenge Modal

- [ ] Reusable `<HardwareKeyChallenge />` component
- [ ] Triggered on HTTP 428 responses
- [ ] Shows required key info from 428 body
- [ ] Triggers `navigator.credentials.get()` for assertion
- [ ] Records assertion via `POST /keys/assertions`
- [ ] Retries original request automatically

### Priority 3: Asset Protection Policies (Admin UI)

- [ ] Policy configuration on repository/project/document settings pages
- [ ] `POST /keys/policies` — create policy
- [ ] `GET /keys/policies?asset_type=X&asset_id=Y` — show existing policies
- [ ] `DELETE /keys/policies/:id` — remove policy

### Priority 4: Encrypted Data (Advanced)

- [ ] Client-side encryption using Web Crypto API
- [ ] `POST /keys/encrypted-data` — store encrypted payload
- [ ] `GET /keys/encrypted-data/:id` — retrieve with key challenge
- [ ] `PATCH /keys/encrypted-data/:id/authorized-keys` — key rotation
- [ ] Decryption in browser using derived key material

### Optional: Semantic Router UI

- [ ] Model override dropdown in chat UI (advanced mode)
- [ ] Pass `model_name_override` in run configurable
- [ ] Display which model was used in message metadata (from `chat_messages.metadata.model`)

---

## Testing Checklist

### Hardware Keys — Integration Test Flow

1. **Register a key:** Sign up → go to security settings → register hardware key → verify it appears in list
2. **Create a policy:** Go to repository settings → add "Require hardware key for decrypt" policy
3. **Store encrypted data:** Encrypt something client-side → `POST /keys/encrypted-data`
4. **Key-gated retrieval:** `GET /keys/encrypted-data/:id` → expect 428 → touch key → assertion → retry → 200
5. **Consume assertion:** Verify the assertion is marked as consumed (can't re-use)
6. **Re-consume assertion:** Retry retrieval → expect 428 again (new assertion needed)
7. **Deactivate key:** Deactivate → verify assertions fail for that key

### Semantic Router — No Webapp Testing Needed

The semantic router is tested at the runtime/infrastructure level. The webapp's existing chat flow works unchanged.