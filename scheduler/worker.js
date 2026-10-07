/**
 * Starts the bots on time. GitHub's own scheduler starts scheduled workflows hours late on a
 * busy day; this Cloudflare Worker has cron triggers that fire on the minute, and each one asks
 * GitHub to run a workflow now (the same thing as the "Run workflow" button).
 *
 * Settings: GH_REPO ("owner/name", in wrangler.toml) and the secret GH_TOKEN, a fine-grained
 * GitHub token limited to that repository with the permission "Actions: read and write".
 * The workflows keep their own safeguards: a draw is published once, a teaser is posted once.
 */
const SCHEDULE = {
  // tickets, two to three hours before each draw ("scheduled": no recap when nothing happened)
  "13 3,4,15,16 * * *": { workflow: "play.yml", inputs: { scheduled: "true" } },
  "30,44 5,17 * * *": { workflow: "teaser.yml" },   // the film, half an hour before
  "1,5,35 6,18 * * *": { workflow: "results.yml" }, // the result, right after
};

async function start({ workflow, inputs }, env) {
  const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "lottery-scheduler", "content-type": "application/json" },
    body: JSON.stringify({ ref: env.GH_REF || "main", ...(inputs ? { inputs } : {}) }),
  });
  // GitHub answers 204 with no body. Its error text can name the repository: only the status is kept.
  if (!res.ok) throw new Error(`GitHub refused to start ${workflow} (${res.status})`);
}

export default {
  async scheduled(event, env) {
    const job = SCHEDULE[event.cron];
    if (!job) throw new Error("no workflow for this schedule: " + event.cron);
    await start(job, env);
  },
  // nothing is served: the worker only exists for its schedule
  fetch() { return new Response("", { status: 404 }); },
};
export { SCHEDULE };
