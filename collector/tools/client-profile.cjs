function selectProfile(config, imageSha256) {
  const profiles = config.builds || [config]
  const matches = profiles.filter(p => p.imageSha256 === imageSha256)
  return matches.length === 1 ? matches[0] : null
}
module.exports = { selectProfile }
