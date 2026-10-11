/** Select the application page, excluding the short-lived preference migration window. */
export async function applicationWindow(app, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const page = app.windows().find((candidate) => !candidate.isClosed() && candidate.url().startsWith('jcad://app/index.html'));
    if (page) return page;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('The secure application window did not appear before the deadline.');
}
