const { execFileSync } = require('node:child_process')
process.chdir(require('node:path').resolve(__dirname, '..'))
// Legacy detector/follow-back implementation tests target functions removed from
// the injected content script before this maintenance. Keep them for reference.
for (const file of ['check-lifecycle', 'check-collection-delay', 'check-feature-auth', 'check-followback-host', 'check-oauth-clean', 'check-profile-reset', 'check-renderer', 'check-xp-identity']) {
  execFileSync(process.execPath, [`scripts/${file}.cjs`], { stdio: 'inherit' })
}
