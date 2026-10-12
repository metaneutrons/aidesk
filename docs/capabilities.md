# Capability differences

Source authority: `src/domain/capabilities.ts`. Every implemented domain
capability belongs in that registry before expansion. These differences are
open delivery records, not exemptions from the product plan.

| Capability | UI | REST | MCP | Current difference |
| --- | --- | --- | --- | --- |
| projects.list | Staff desk | GET /projects | projects_list | Same scoped operation |
| tickets.list | Staff desk | GET /tickets | tickets_list | Same scoped operation; pagination and full aggregates pending |
| tickets.get | Conversation | GET /tickets/:id | tickets_get | Same scoped operation |
| tickets.reply | Composer | POST /tickets/:id/reply | tickets_reply | Same revision/idempotency operation; autonomous agent dispatch remains disabled unless explicitly configured |
| tickets.note | Composer | POST /tickets/:id/reply with internal=true | tickets_reply with internal=true | Same operation and separate note permission |
| projects.create | Owner dialog | POST /projects | Pending | Current MCP credentials are project-scoped agents; workspace delegation/provisioning remains M1 work |
| operator.locale | Staff preference | POST /me/locale | Pending | Human preference; a scoped agent is not a human operator |
| agents.issue | Pending | POST /projects/:id/agents | Not offered | Tokens are issued by people only; an agent issuing tokens could extend its own reach and lifetime. Settings UI is M3 work |
| agents.list | Pending | GET /projects/:id/agents | Not offered | Same boundary as agents.issue; never returns token values or hashes |
| agents.revoke | Pending | POST /agents/:id/revoke | Not offered | Same boundary as agents.issue |

SSO protocol endpoints belong to Better Auth. The application restricts provider
management to active human owners. Per-project discovery still requires explicit
membership, including for owners. Theme, client search and local draft retention
are UI state, not server mutations. The first inbox search only searches the
loaded slice; server search and pagination require later qualification.
