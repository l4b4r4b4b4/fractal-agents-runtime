# UX Guide: User-Scoped Assets — Store & Cron Jobs

> **Audience:** Frontend / product team
> **Context:** The Fractal Agents Runtime exposes two user-scoped asset types
> beyond threads and assistants: a **key-value store** (cross-thread agent
> memory) and **cron jobs** (scheduled agent runs). This document provides
> concrete UX/UI recommendations for surfacing them in the webapp.
>
> **Date:** 2026-02-20

---

## How These Assets Are Scoped

| Resource | Scope | Tied to agent? | Tied to thread? | API |
|----------|-------|---------------|----------------|-----|
| **Store items** | `owner_id` (user from JWT) | No — cross-agent | No — cross-thread | `PUT/GET/DELETE /store/items`, `POST /store/items/search`, `GET /store/namespaces` |
| **Cron jobs** | `owner_id` + `assistant_id` | **Yes** — requires an assistant | No — creates new threads on each run | `POST /runs/crons`, `POST /runs/crons/search`, `DELETE /runs/crons/{id}` |

Key implication: **store is global per user**, **crons are per agent per user**.
This maps cleanly to the multi-tenant model where the platform handles org-level
visibility and the runtime enforces user-level isolation.

---

## 1. Store → "Gedächtnis" (Agent Memory)

### What It Is

The store is a cross-thread key-value database scoped to the authenticated user.
Agents can read and write to it during conversations to persist preferences,
context, and summaries across chat sessions.

Users don't think in namespaces and keys. They think: **"What does the agent
remember about me?"**

### Where to Put It

**Location:** Settings/gear icon on the agent card or chat sidebar →
"Gedächtnis" tab. Alternatively, a section in the user's account settings
if memory is shared across agents.

Do **not** put it prominently — most users will never look at this. Power users
find it; casual users are not overwhelmed.

### Visual Design

```
┌─────────────────────────────────────────────────────┐
│  ⚙️ Einstellungen  ›  🧠 Gedächtnis                │
│                                                     │
│  Was sich der Assistent über dich merkt:            │
│                                                     │
│  ┌─ Kontext & Wissen ──────────────────────────┐   │
│  │                                              │   │
│  │  🏢 Zuständig für: Objekt Friedrichstr. 42  │🗑️│
│  │  📋 Letzte Anfrage: Nebenkostenabrechnung   │🗑️│
│  │     2024 für Einheit 2.01                    │   │
│  │                                              │   │
│  ├─ Einstellungen ─────────────────────────────┤   │
│  │                                              │   │
│  │  🌐 Bevorzugte Sprache: Deutsch             │🗑️│
│  │  📊 Berichtsformat: Zusammenfassung         │🗑️│
│  │                                              │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  [🗑️ Alles vergessen]                              │
│                                                     │
│  ℹ️ Der Assistent speichert Informationen aus       │
│  deinen Gesprächen, um dir besser helfen zu können. │
│  Du kannst einzelne Einträge oder alles löschen.    │
└─────────────────────────────────────────────────────┘
```

### API Mapping

| User action | API call |
|-------------|----------|
| View memory items | `GET /store/namespaces` → for each: `POST /store/items/search` with namespace |
| Delete single item | `DELETE /store/items?namespace=context&key=assigned_property` |
| "Alles vergessen" | For each namespace: search all items, delete each |
| (Agent writes during chat) | Agent calls `PUT /store/items` via LangGraph `store` parameter |

### UX Decisions

1. **Read-only view by default.** The agent writes memory during conversations
   ("Ich merke mir, dass du für Objekt X zuständig bist"). The user can *see*
   and *delete* but should not manually edit — avoids confusion about format
   and prevents breaking agent expectations.

2. **Group by namespace with friendly labels.** Map internal namespace strings
   to human-readable German categories:

   | Namespace | Display label |
   |-----------|--------------|
   | `preferences` | Einstellungen |
   | `context` | Kontext & Wissen |
   | `history` | Vergangene Zusammenfassungen |
   | `facts` | Fakten & Notizen |
   | *(other)* | Show namespace as-is (for extensibility) |

3. **"Alles vergessen" button.** Facility managers and tenants want this for
   privacy. Prominently placed at the bottom, with a confirmation dialog.

4. **Show when memory was last updated.** Each item should display a relative
   timestamp ("vor 2 Tagen") so users know how stale the information is.

5. **Notification on first write.** The first time an agent stores something,
   show a subtle toast: "🧠 Der Assistent hat sich etwas gemerkt. Du kannst
   das Gedächtnis in den Einstellungen einsehen."

---

## 2. Crons → "Automatisierungen" (Scheduled Tasks)

### What It Is

Cron jobs let users schedule periodic agent runs — the agent executes a
predefined prompt on a schedule and produces results in a new thread. This is
where the platform becomes genuinely useful for facility managers who want
automated periodic reports, checks, and reminders.

### Where to Put It

**Location:** Dedicated tab on the agent detail page. Crons are a foreground
feature — users actively create and monitor them.

Additionally, consider a top-level "Automatisierungen" or "Berichte" section
in the sidebar that aggregates cron output across all agents.

### Visual Design — List View

```
┌─────────────────────────────────────────────────────────┐
│ 🤖 Dokumenten-Assistent                                │
│                                                         │
│  [💬 Chat]  [📁 Archiv]  [⚡ Automatisierungen]        │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │ 📋 Wöchentlicher Wartungsbericht                  │  │
│  │    🕐 Jeden Montag um 08:00                       │  │
│  │    "Erstelle eine Zusammenfassung aller           │  │
│  │     offenen Wartungsaufgaben"                     │  │
│  │                                                   │  │
│  │    Letzter Lauf: Mo 17.02, 08:03 — ✅ Erfolgreich │  │
│  │    [📄 Bericht ansehen]                           │  │
│  │                                                   │  │
│  │                          [⏸ Pausieren]    [🗑️]    │  │
│  ├───────────────────────────────────────────────────┤  │
│  │ 📋 Monatliche Nebenkostenprüfung                  │  │
│  │    🕐 1. des Monats um 09:00                      │  │
│  │    "Prüfe ob neue Nebenkostenabrechnungen         │  │
│  │     vorliegen und fasse Auffälligkeiten zusammen" │  │
│  │                                                   │  │
│  │    Letzter Lauf: 01.02, 09:01 — ✅ Erfolgreich    │  │
│  │    [📄 Bericht ansehen]                           │  │
│  │                                                   │  │
│  │                              [▶ Aktiv]    [🗑️]    │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  [+ Neue Automatisierung erstellen]                     │
└─────────────────────────────────────────────────────────┘
```

### Visual Design — Creation Flow

Keep it dead simple. Three steps, no raw cron syntax.

```
┌─────────────────────────────────────────────────────────┐
│  ⚡ Neue Automatisierung                                │
│                                                         │
│  Schritt 1: Was soll der Assistent tun?                │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Erstelle eine Zusammenfassung aller offenen     │   │
│  │ Wartungsaufgaben und liste überfällige Termine  │   │
│  │ auf.                                            │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  Schritt 2: Wie oft?                                   │
│  ┌─────────────────────────────────────┐               │
│  │  ○ Täglich         um [08:00] Uhr  │               │
│  │  ● Wöchentlich     am [Montag ▾]   │               │
│  │                    um [08:00] Uhr   │               │
│  │  ○ Monatlich       am [1.  ▾]      │               │
│  │                    um [09:00] Uhr   │               │
│  │  ○ Benutzerdefiniert               │               │
│  │    [cron expression: __________ ]   │               │
│  └─────────────────────────────────────┘               │
│                                                         │
│  Schritt 3: Name (optional)                            │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Wöchentlicher Wartungsbericht                   │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│              [Abbrechen]  [✅ Erstellen]                │
└─────────────────────────────────────────────────────────┘
```

### API Mapping

| User action | API call |
|-------------|----------|
| View automations | `POST /runs/crons/search` with `assistant_id` filter |
| Create automation | `POST /runs/crons` with `{ assistant_id, schedule, payload: { input: { messages: [...] } } }` |
| Delete automation | `DELETE /runs/crons/{cron_id}` |
| Pause/resume | Update cron status (if supported) or delete + recreate |
| View cron output | List threads created by the cron (filter by metadata) |
| Count badge | `POST /runs/crons/count` with `assistant_id` filter |

### Schedule Preset → Cron Expression Mapping

| Preset | Cron expression |
|--------|----------------|
| Täglich um 08:00 | `0 8 * * *` |
| Wöchentlich Mo 08:00 | `0 8 * * 1` |
| Wöchentlich Fr 17:00 | `0 17 * * 5` |
| Monatlich 1. um 09:00 | `0 9 1 * *` |
| Monatlich 15. um 09:00 | `0 9 15 * *` |

Always convert user-friendly selections to cron expressions before sending to
the API. Only show the raw expression in "Benutzerdefiniert" mode.

### UX Decisions

1. **Show last run result.** This is what makes crons tangible. Display the
   timestamp, status (✅/❌), and a link to the generated thread/conversation.
   Without this, crons feel like a black box.

2. **Pause, don't just delete.** Facility managers create complex automations.
   Let them pause and resume without losing the configuration. If the API
   doesn't support pause natively, implement it client-side by storing the
   cron config in the store before deleting, and recreating on resume.

3. **Cron output goes to dedicated threads.** Don't dump results into an
   existing chat. Each cron run creates a new thread. Surface these in a
   "Berichte" (Reports) section, grouped by automation. This gives users a
   clean history of automated outputs.

4. **Limit to the agent's capabilities.** If the agent has RAG archives, the
   cron can search them. If the agent has MCP tools, the cron can use them.
   Make this clear in the creation UI — show a hint like "Dieser Assistent
   kann auf folgende Archive zugreifen: Wartungsdokumentation, Mietverträge".

5. **Empty state matters.** When no automations exist, show a compelling
   empty state with examples:
   ```
   ⚡ Keine Automatisierungen vorhanden

   Beispiele für nützliche Automatisierungen:
   • Wöchentlicher Wartungsüberblick
   • Monatliche Nebenkostenprüfung
   • Tägliche Zusammenfassung neuer Dokumente

   [+ Erste Automatisierung erstellen]
   ```

6. **Run count / next run info.** Show "Nächster Lauf: Mo 24.02, 08:00" and
   "Bisher 12 Läufe" on each card. Gives confidence the automation is working.

---

## 3. Navigation Structure

Recommended placement in the webapp sidebar and agent detail pages:

```
Sidebar (global):
├── 🏠 Dashboard
├── 💬 Chats                        ← user's threads
├── 🤖 Agenten                      ← user's assistants
│   └── [Agent Detail Page]
│       ├── 💬 Chat                 ← start/continue conversation
│       ├── 📁 Archiv               ← rag_config archives
│       ├── ⚡ Automatisierungen     ← crons for this agent
│       └── ⚙️ Einstellungen        ← agent config + memory (store)
├── 📊 Berichte                     ← cron output threads (aggregated)
└── ⚙️ Einstellungen                ← user account, global memory
```

### Why This Structure

- **Store (memory)** is buried in settings — it's a background feature that
  most users interact with indirectly through conversations.
- **Crons (automations)** get their own tab per agent — it's a foreground
  feature that users actively create and monitor.
- **Berichte (reports)** aggregates cron output across all agents in one place —
  facility managers want a single view of all automated outputs without
  navigating to each agent individually.

---

## 4. Real-Estate Use Cases

Concrete automation ideas for the Immobilien / facility-management domain to
use as examples, onboarding hints, and template suggestions:

### Wartung & Instandhaltung (Maintenance)

| Automation | Schedule | Prompt |
|-----------|----------|--------|
| Wartungsüberblick | Wöchentlich Mo 08:00 | "Erstelle eine Zusammenfassung aller offenen Wartungsaufgaben und überfälligen Termine." |
| TÜV-Erinnerung | Monatlich 1. 09:00 | "Prüfe welche TÜV-Prüfungen, Aufzugsinspektionen oder Brandschutzbegehungen in den nächsten 30 Tagen fällig sind." |

### Kosten & Abrechnung (Costs)

| Automation | Schedule | Prompt |
|-----------|----------|--------|
| Nebenkostenprüfung | Monatlich 1. 09:00 | "Prüfe ob neue Nebenkostenabrechnungen vorliegen und fasse Auffälligkeiten zusammen." |
| Energieverbrauch-Report | Monatlich 15. 08:00 | "Erstelle einen Vergleich des Energieverbrauchs zum Vormonat und Vorjahr." |

### Mietverträge (Leases)

| Automation | Schedule | Prompt |
|-----------|----------|--------|
| Vertragsverlängerungen | Monatlich 1. 09:00 | "Welche Mietverträge laufen in den nächsten 6 Monaten aus? Liste Kündigungsfristen auf." |
| Mietrückstände | Wöchentlich Mi 08:00 | "Prüfe ob offene Mietzahlungen vorliegen und erstelle eine Übersicht." |

### Gebäude & Sicherheit (Building & Safety)

| Automation | Schedule | Prompt |
|-----------|----------|--------|
| Brandschutz-Check | Monatlich 1. 08:00 | "Prüfe den Status aller Brandschutzmaßnahmen und offenen Mängel." |
| Gebäudestatus-Report | Wöchentlich Fr 16:00 | "Erstelle einen Wochenüberblick: offene Tickets, abgeschlossene Wartungen, anstehende Termine." |

These can be offered as **templates** in the creation flow — user picks a
template, adjusts the prompt and schedule, done.

---

## 5. Technical Notes for Frontend Implementation

### Store API Quirks

- `GET /store/items` requires both `namespace` and `key` as query params —
  you cannot get all items in a namespace with one call. Use
  `POST /store/items/search` with just `namespace` to list all items.
- `GET /store/namespaces` returns all namespaces for the user — use this to
  build the grouped memory view.
- Values are arbitrary JSON objects. The frontend should display them as
  formatted text, not raw JSON.

### Cron API Quirks

- `POST /runs/crons` requires `assistant_id` and `schedule` (cron expression).
- The `payload` field contains the input that will be sent to the agent on
  each run — structure it as `{ input: { messages: [{ role: "user", content: "..." }] } }`.
- There is no native "pause" endpoint — implement pause/resume by deleting the
  cron and storing its config in the store (namespace: `cron_backups`) for later
  recreation.
- Cron output threads are created automatically. Tag them with metadata
  (e.g. `{ source: "cron", cron_id: "..." }`) so the frontend can filter them
  for the "Berichte" view.

### Permissions

Both store and crons are scoped to the authenticated user's JWT `sub` claim.
The frontend does not need to pass any additional ownership information — the
runtime extracts it from the Authorization header.

If the platform needs org-level visibility (e.g. admin sees all users' crons),
that must be handled at the platform layer, not the runtime.