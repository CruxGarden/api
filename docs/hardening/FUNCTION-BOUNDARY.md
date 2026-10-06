# Function execution boundary — 2026-09-22

The previous Node `vm` context was not a security boundary. A harmless local probe obtained `typeof process === 'object'` through the supplied `ctx.log` callback's constructor. A synchronous infinite loop also required killing the isolated probe process: the previous Promise timeout could not run while its thread was blocked. No files, credentials or network were accessed in these probes.

The API now creates a fresh isolated-vm V8 isolate for each invocation (32 MB limit). Request/context data and results cross as bounded JSON. Only the existing scoped Store, event, logging, secrets and allowlisted fetch operations are bridged. Async host references remain in a private closure; handler compilation uses a new isolate-local Function with no closure access. The handler never receives a host Reference. A five-second isolate execution timeout handles synchronous loops and microtask loops; a wall timer disposes unresolved asynchronous work. Four concurrent runs are allowed per Crux and across the process. Source is limited to 256 KB, transfers to 1 MB, and bridged calls to 1,000 per run.

Validation on Node 22.22.3 / macOS arm64:

- Focused runner/service suite: 18 passing tests, including ordinary request/Store/fetch/secrets/response contracts, prototype-constructor escape probes, private dispatch visibility, synchronous and post-await runaway code, unresolved promises, and successful execution after timeouts.
- Full API verify: 642 passed, five existing skips; lint and Nest build passed.
- An allocation-pressure probe ran in a disposable Node process: the isolate was disposed, the enclosing process survived and exited 0. This is one bounded probe, not exhaustive OOM resilience.
- API integration suite: 209 passed. This suite uses repository test doubles; it is not deployment or live-database evidence.

Runtime dependency is isolated-vm 5.0.4, the upstream-supported Node 22 line. API start/test scripts use `--no-node-snapshot`. Docker build needs Python/make/g++, runtime needs libstdc++; its launch command includes the same Node flag. The Linux arm64 container built successfully with `docker build -f docker/Dockerfile -t crux-api-hardening:local .`; a network-disabled container invocation returned `{answer:42,process:"undefined"}` through the production runner. Deployment is not performed.

Limits: isolate memory limits are approximate, and native catastrophic allocation errors can still terminate the containing API process. A separate process/container boundary is recommended by upstream for hostile workloads. These regressions establish the listed boundaries, not an exhaustive security audit. Already-dispatched Store writes or outbound requests are not rolled back when a handler times out. Outbound policy remains enforced by the existing host-side fetch implementation. Multi-instance global concurrency remains per API process.

Primary references: [Node vm documentation](https://nodejs.org/api/vm.html), [isolated-vm documentation and security guidance](https://github.com/laverdet/isolated-vm). ADR 0051 explicitly named isolated-vm as the required next boundary before shared public hosting; this implements that step without claiming complete hostile-host isolation.
