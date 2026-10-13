# Capability differences

Source authority: `src/domain/capabilities.ts`. Every implemented domain
capability belongs in that registry before expansion. These differences are
open delivery records, not exemptions from the product plan.

| Capability                | UI                         | REST                                       | MCP                              | Current difference                                                                                                                                    |
| ------------------------- | -------------------------- | ------------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| projects.list             | Staff desk                 | GET /projects                              | projects_list                    | Same scoped operation                                                                                                                                 |
| tickets.list              | Staff desk                 | GET /tickets                               | tickets_list                     | Same scoped operation; pagination and full aggregates pending                                                                                         |
| tickets.get               | Conversation               | GET /tickets/:id                           | tickets_get                      | Same scoped operation                                                                                                                                 |
| tickets.reply             | Composer                   | POST /tickets/:id/reply                    | tickets_reply                    | Same revision/idempotency operation; autonomous agent dispatch remains disabled unless explicitly configured                                          |
| tickets.note              | Composer                   | POST /tickets/:id/reply with internal=true | tickets_reply with internal=true | Same operation and separate note permission                                                                                                           |
| attachments.get           | Conversation download link | GET /attachments/:id                       | Pending                          | Metadata is part of tickets_get on every surface; binary content over MCP needs a size limit and a decision which types an agent may read             |
| junk.list                 | Junk view                  | GET /junk                                  | Not offered                      | Junk decisions are made by people until the governed AI classification of M4-A6; agents do not read junk                                              |
| junk.get                  | Junk view                  | GET /junk/:id                              | Not offered                      | Same boundary as junk.list; the preview is sanitized and the original stays private                                                                   |
| junk.restore              | Junk view                  | POST /junk/:id/restore                     | Not offered                      | Same boundary as junk.list                                                                                                                            |
| tickets.junk              | Conversation               | POST /tickets/:id/junk                     | Not offered                      | Same boundary as junk.list                                                                                                                            |
| tickets.restore           | Junk view                  | POST /tickets/:id/restore                  | Not offered                      | Same boundary as junk.list                                                                                                                            |
| projects.settings         | Settings                   | POST /projects/:id/settings                | Not offered                      | Project behaviour such as acknowledgements is changed by people with project.manage; an agent could otherwise send automatic mail on its own decision |
| messages.original         | Conversation download link | GET /messages/:id/original                 | Pending                          | The extracted Markdown is part of tickets_get; the raw original over MCP needs a size limit and a decision what an agent may read                     |
| messages.original_preview | Original preview dialog    | GET /messages/:id/original/preview         | Not offered                      | A person checks a shortened extraction visually; the safe view is for human eyes and an agent reads the extracted Markdown                            |
| projects.create           | Owner dialog               | POST /projects                             | Pending                          | Current MCP credentials are project-scoped agents; workspace delegation/provisioning remains M1 work                                                  |
| operator.locale           | Staff preference           | POST /me/locale                            | Pending                          | Human preference; a scoped agent is not a human operator                                                                                              |
| agents.issue              | Settings                   | POST /projects/:id/agents                  | Not offered                      | Tokens are issued by people only; an agent issuing tokens could extend its own reach and lifetime                                                     |
| agents.list               | Settings                   | GET /projects/:id/agents                   | Not offered                      | Same boundary as agents.issue; never returns token values or hashes                                                                                   |
| agents.revoke             | Settings                   | POST /agents/:id/revoke                    | Not offered                      | Same boundary as agents.issue                                                                                                                         |
| operators.list            | Settings                   | GET /operators                             | Not offered                      | Identity administration is done by people; grants are shown only for projects the caller manages                                                      |
| operators.create          | Settings                   | POST /operators                            | Not offered                      | Owner only; agents never create identities                                                                                                            |
| operators.grant           | Settings                   | POST /operators/:id/grants                 | Not offered                      | Needs project.manage on that project and never exceeds the caller's own actions                                                                       |
| operators.active          | Settings                   | POST /operators/:id/active                 | Not offered                      | Owner only; owners and the caller cannot be disabled here                                                                                             |

Server operations without a surface yet, deliberately not in the registry:
portal grants (`src/server/portal.ts`), translation records
(`src/server/translation.ts`), email designs (`src/server/email-design.ts`) and
the sent snapshot (`getSentSnapshot`). They are read or changed by people with
the rights named in `docs/development.md`, and agents are excluded from the
ones that change state. A surface is added with the M3 operator and portal work,
and each then gets a registry entry and a row above.

SSO protocol endpoints belong to Better Auth. The application restricts provider
management to active human owners. Per-project discovery still requires explicit
membership, including for owners. Theme, client search and local draft retention
are UI state, not server mutations. The first inbox search only searches the
loaded slice; server search and pagination require later qualification.
