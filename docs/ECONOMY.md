# Founding, managers and city accounts

After choosing a character, the first authenticated founder configures the shared city. Headquarters, a residence and the chief of staff are always included. The founder can select zero to five additional buildings: hospital, academy, café, energy campus and recreation centre. This district currently has one parcel of each type, so the starting building count is two through seven. The Innovation studio is a separate parcel purchased later. There is no arbitrary placement or unlimited duplicate buildings yet.

The server accepts founding once. Selected buildings and one service employee per business are a founding grant; the initial treasury remains 100,000 credits. Existing buildings, staff and treasury survive upgrades from version one, with an `empire.json.v1-backup` kept before migration. A browser refresh, a second client or a repeated request cannot repeat the grant. Character preferences remain per browser; founding choices and accounts belong to the shared server city.

## Real work and persistent appointments

Founding appoints named managers and a chief of staff. Each receives one bounded task in the existing real AI queue: inspect the connected project and produce a sector brief in `docs/empire/`. The task uses the configured agent account, normal concurrency and usage budget; no credentials are collected by the setup screen. Existing worktree and pull-request behavior still applies. Queue job keys persist and prevent duplicate startup tasks after interrupted dispatch.

An appointment is pending/queued until the real worker starts, and failed or disconnected startup is marked offline. Buildings do not pretend to have live AI workers while the queue is paused. Once startup has completed, the manager remains assigned and ready for subsequent work even if the temporary worker process is recycled. Building entry accepts this durable ready assignment or an actual assigned live worker. Failed startups can be retried in Management. The persistent manager avatar and the real task record are connected through manager/task/worker IDs.

The chief of staff has a real startup brief plus deterministic ongoing administrative monitoring. Sector status, worker requests, payroll and treasury reports continue while the server runs, including while the CEO is present. Delegation changes oversight, not whether monitoring exists. This is not a continuously reasoning autonomous executive or a permanently running paid AI process. Users still assign the real project work and approve worker requests themselves.

## Money rules

All city money is simulation credits. Provider usage remains real money in the existing usage panel. Simulated services do not demonstrate real commercial revenue or AI task completion.

One real second advances one city minute; one operating hour settles every 60 seconds of server uptime. Time spent with the server shut down does not earn catch-up revenue. Operating revenue requires a built business, an active/ready manager appointment and service staff.

| Account | Rule |
| --- | --- |
| Service revenue/hour | `(sector base + staff × 28) × (1 + 0.3 × (level − 1))`, rounded |
| Sector bases | Hospital 180; academy 145; café 100; energy 160; recreation 120; studio 195; HQ 0 |
| Service wages | 18 per employee/hour |
| Manager wages | 40/hour; chief of staff 60/hour |
| Building upkeep | 20 × level/hour; headquarters 10/hour |
| Founder dividend | 20% of positive net operating income, rounded down |
| Completed real AI task | 500 gross credits: 50 worker pay, 90 founder dividend, 360 retained by city |
| Hiring | 1,200 per service employee, up to building capacity |
| Upgrades | Up to level 3; half the base construction price × current level |
| Expansion | Studio land 18,000, followed by 22,000 construction |

Completed-task rewards require the real queue's successful `done` outcome, a worker ID and a finish timestamp after founding. Failed, killed, historical and workerless tasks earn no reward. A task ID is paid once across retries and restarts. This observes the upstream queue's completion signal; it does not independently certify the quality of an agent's output.

The city retains revenue after wages, upkeep and dividends. Founder dividends accumulate in a wallet and can be reinvested. Every service employee and AI manager/worker has a cumulative earned-credit account. A building's operating payroll is skipped if the treasury plus its operating revenue cannot fund it; no negative balance is created. Building purchases, hiring, land, upgrades and reinvestments are also recorded in the ledger. Recent ledger entries are bounded to 100; cumulative totals and reward identities persist.

The accounting identity is `current treasury = opening treasury + gross revenue − wages − upkeep − dividends − net capital spending`. Reinvestments are negative capital spending. The opening treasury may differ for a migrated city. No real payments are made by this system.

## Graphics and verification

The recreation centre, studio, manager avatars and upgrade details reuse the district's existing PBR materials, human rigs and architecture. Level two adds roof solar panels; level three adds planted frontage. The map and playable bounds include the new parcels.

Automated tests exercise the founding grant, malformed and duplicate requests, queue-key persistence, worker-gated entry, completion rewards, payroll reconciliation, insolvency, land/build/upgrade rules and version-one migration. Manual checks use an isolated city with the queue paused; they never start paid workers. The development graphics review includes a Recreation view. Actual provider execution still depends on the configured agent CLI and account; it is not exercised by these tests.
