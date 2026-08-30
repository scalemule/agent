# `@scalemule/agent`

ScaleMule SDK for AI-agent task runtimes and the customer-hosting CLI.

## Customer hosting

Customer developers and supervised AI agents deploy with a project-scoped
release token. They do not need and must not receive AWS, GCP, Kubernetes,
registry, internal ScaleMule, or runtime application credentials.

```bash
export SCALEMULE_DEPLOY_TOKEN='value supplied by the project owner'
npx --yes @scalemule/agent@0.0.2 whoami
npx --yes @scalemule/agent@0.0.2 deploy --environment prod --wait
```

The CLI refuses a dirty working tree, pushes and verifies the current immutable
Git commit by default, and submits its full SHA. Use `--no-push` only when that
exact commit is already available from the configured branch; ScaleMule still
verifies the submitted SHA against that branch before building. The CLI reads
the release credential only from `SCALEMULE_DEPLOY_TOKEN`; there is no token
command-line flag.

Owners/admins create a short-lived release credential with their ScaleMule
customer-member login:

```bash
npx --yes @scalemule/agent@0.0.2 login \
  --email owner@example.com \
  --application APPLICATION_ID

npx --yes @scalemule/agent@0.0.2 release-token create \
  --project PROJECT_SLUG \
  --environment prod \
  --branch main \
  --name contractor \
  --expires-days 30
```

Run `npx --yes @scalemule/agent@0.0.2 help` for all commands. The hosting
service and CLI must complete the ScaleMule rollout gates before use in a real
customer environment.

## Agent runtime SDK

```ts
import { ScaleMuleAgent } from '@scalemule/agent'

const agent = new ScaleMuleAgent({
  apiKey: process.env.SCALEMULE_API_KEY!,
  agentToken: process.env.SCALEMULE_AGENT_TOKEN!,
  agentId: process.env.SCALEMULE_AGENT_ID!,
})

await agent.connect()
const task = await agent.claimNext()
```

The task-runtime credentials above are separate from customer-hosting release
tokens and must not be interchanged.
