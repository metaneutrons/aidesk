# Qualification of the Chat SDK for messenger notifications

Evidence for M9-A1 of [the administration plan](../plans/administration.md). Question: can the Chat SDK
([`vercel/chat`](https://github.com/vercel/chat), npm `chat`) be the basis of notifications to a person in a
messenger (a channel post, a direct message, a card), run in the worker of aidesk, with credentials of each
project? Date: 2026-10-18. Versions: `chat` and every `@chat-adapter/*` 4.42.0 (published 2026-10-14), Node 26.11,
pnpm 12.11, PostgreSQL 18.

The run is a spike outside the repository. It used a fake Slack Web API that records what it receives, not a real
workspace, and it did not touch Teams.

## Result

| Question                                       | Result                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Post to a channel without an incoming event    | Yes: `chat.channel("slack:C123").post(...)` sent `chat.postMessage` and returned the id of the message.                                                                                                                                                                             |
| Direct message to a user id                    | Yes: `chat.openDM("U123")` called `conversations.open`, `post` sent the message.                                                                                                                                                                                                    |
| Resolve a user, to map an operator by address  | Yes: `chat.getUser("U123")` returned the e-mail address and the name (Slack needs the scope `users:read.email` for it, according to the type comment).                                                                                                                              |
| Several projects with credentials of their own | Yes: two `Chat` instances with different bot tokens ran in one process; every call carried the token of its own instance.                                                                                                                                                           |
| Runs in the worker                             | Yes: plain Node, no web framework and no inbound endpoint for messages that only go out.                                                                                                                                                                                            |
| Card                                           | A card with a title, a text and a link button went out as Block Kit (`header`, `section`, `actions`) with a text as fallback.                                                                                                                                                       |
| State in PostgreSQL                            | Works. The adapter creates five tables (`chat_state_cache`, `_lists`, `_locks`, `_queues`, `_subscriptions`). With `autoCreateSchema: false` the nine statements of `postgresSchemaStatements` can go into our own migrations. It uses `pg`, a second client next to `postgres.js`. |
| Time                                           | Both instances initialised in about 60 ms; a post took a few milliseconds (against a local fake, so without a network).                                                                                                                                                             |
| Supply chain                                   | 220 packages, 99 MB with the Slack and the Teams adapter. Licences: MIT (202), ISC (7), Apache-2.0 (5), BSD-3-Clause (2), BlueOak-1.0.0 (1). `pnpm audit`: no known vulnerabilities. The install passed the default checks of pnpm 12.                                              |

The weight comes mostly from the Teams adapter, which brings the Microsoft Teams SDK (`@microsoft/teams.graph-endpoints`
alone is 44 MB). The Slack adapter uses the official `@slack/web-api` (7.6 MB). The size of an install with only the
Slack adapter was not measured.

## What the spike does not show

- **A real workspace.** The scopes that Slack needs (`chat:write`, `im:write`, `users:read.email`, and what a channel
  the bot has not joined asks for) were not tried.
- **Teams.** The thread id of the Teams adapter carries a `serviceUrl` that the adapter caches from incoming
  activities (`cacheUserContext`). Proactive posts therefore probably need a bot that is installed in the tenant and
  an endpoint that Azure can reach. That is read from the types, not tried.
- **Discord, Telegram, Google Chat.** Not tried.
- **Interaction.** Buttons that call back (`onAction`), signature checks of incoming requests and the mapping of
  messenger users to operators are the second stage and were not part of this run.

## Decision it supports

Use the Chat SDK for the stage of notifications with direct messages, behind an interface of our own and with the
version pinned, installing only the adapters that are used; Slack first. Notifications to a channel can go out as
formats of the existing webhooks without the SDK. Teams comes last because of its set-up.

## How to repeat it

In an empty directory with a `package.json` that has `"type": "module"`:

```sh
pnpm add chat@4.42.0 @chat-adapter/slack@4.42.0 @chat-adapter/state-pg@4.42.0
docker run -d --rm --name chat-spike-pg -e POSTGRES_PASSWORD=spike -e POSTGRES_DB=spike \
  -p 127.0.0.1:55432:5432 postgres:18-bookworm
node spike.mjs
docker stop chat-spike-pg
```

`spike.mjs`:

```js
import { createServer } from "node:http";
import { Chat, Card, CardText, Actions, Button, LinkButton } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createPostgresState, postgresSchemaStatements } from "@chat-adapter/state-pg";
// A fake Slack Web API: records what arrives, answers like Slack.
const calls = [];
const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
        const method = req.url.replace(/^\/api\//, "").split("?")[0];
        const auth = req.headers.authorization ?? "";
        calls.push({ method, auth, body: body.slice(0, 600), type: req.headers["content-type"] });
        res.setHeader("content-type", "application/json");
        const ok = (extra) => res.end(JSON.stringify({ ok: true, ...extra }));
        if (method === "auth.test")
            return ok({
                user_id: "UBOT",
                bot_id: "BBOT",
                team_id: "T1",
                user: "aidesk",
                team: "t",
            });
        if (method === "chat.postMessage")
            return ok({
                channel: "C123",
                ts: "1700000000.000100",
                message: { text: "x", ts: "1700000000.000100" },
            });
        if (method === "conversations.open") return ok({ channel: { id: "D999" } });
        if (method === "users.info")
            return ok({
                user: {
                    id: "U123",
                    name: "kim",
                    real_name: "Kim",
                    profile: { email: "kim@example.test", display_name: "kim" },
                },
            });
        if (method === "users.lookupByEmail") return ok({ user: { id: "U123" } });
        return ok({});
    });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const apiUrl = `http://127.0.0.1:${fake.address().port}/api/`;
const t0 = Date.now();
const timings = {};
const mark = (name) => (timings[name] = Date.now() - t0);
// One Chat per project, each with its own token, in one process, no web framework.
const make = (name, token, state) =>
    new Chat({
        userName: "aidesk",
        adapters: { slack: createSlackAdapter({ botToken: token, signingSecret: "s", apiUrl }) },
        state,
    });
const state = (prefix) =>
    createPostgresState({
        url: "postgres://postgres:spike@127.0.0.1:55432/spike",
        keyPrefix: prefix,
    });
const a = make("A", "xoxb-project-A", state("proj-a"));
const b = make("B", "xoxb-project-B", state("proj-b"));
await a.initialize();
await b.initialize();
mark("initialized");
const result = {};
// 1. A post to a channel without any incoming event.
const posted = await a.channel("slack:C123").post("New ticket 42 in SnapDog");
result.channelPost = { id: posted?.id, threadId: posted?.threadId };
mark("channelPost");
// 2. A direct message to a user id.
const dm = await a.openDM("U123");
const dmPosted = await dm.post("Your ticket 42 is overdue");
result.dm = { threadId: dm.id, id: dmPosted?.id };
mark("dm");
// 3. The user lookup for the mapping of an operator by e-mail.
result.user = await a.getUser("U123");
mark("getUser");
// 4. A card (Block Kit) with a link button.
const card = Card({
    title: "Ticket 42",
    children: [
        CardText("Waiting for a reply since 2 h."),
        Actions([LinkButton({ url: "https://desk.example.test/?ticket=42", label: "Open" })]),
    ],
});
await b.channel("slack:C777").post({ card, fallbackText: "Ticket 42 waiting" });
mark("card");
await a.shutdown?.();
await b.shutdown?.();
fake.close();
const byToken = (t) => calls.filter((c) => c.auth.includes(t)).map((c) => c.method);
console.log(
    JSON.stringify(
        {
            timings,
            result,
            callsA: byToken("project-A"),
            callsB: byToken("project-B"),
            schemaStatements: postgresSchemaStatements.length,
        },
        null,
        1,
    ),
);
const cardCall = calls.find((c) => c.method === "chat.postMessage" && c.auth.includes("project-B"));
console.log("card request:", cardCall?.type, cardCall?.body.slice(0, 450));
```
