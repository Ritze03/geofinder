# Changelog

All notable user-facing changes, newest first. Categories:

**Added** (new features),
**Fixed** (bug and behaviour fixes),
**Removed** (things taken out),
**Info** (notes worth knowing).

## 2026-10-29

### Added
- **Release builds**: a Linux AppImage and a portable Windows exe can be built and
  downloaded from the GitHub Releases page.

## 2026-10-28

### Added
- **Berlin start points**: maps start at Berlin locations, and switching between Google
  and Apple Maps teleports you to the same spot.
- **Rating progress**: the host sees how many players have finished rating.
- **Doesn't fit rating**: a new "Doesn't fit" option when a find does not match the
  category; it scores zero and does not count against your average.
- **Big rating bar**: a large star bar at the bottom of the review screen rates the
  selected find.

### Fixed
- **Fairer scores**: with three or more players, each player's ratings are normalised
  against their own average so a strict or generous rater does not skew the result.
- **Empty category**: the review viewer is hidden when a category has no submissions.

### Info
- **Review advances together**: every player presses Ready and the review moves on as
  soon as everyone is ready, with no countdown; the host's Next, Previous and Show
  results buttons still override.

## 2026-10-21

### Added
- **Live map links**: players now submit and share live Google or Apple Maps links instead
  of screenshots, with a clean map view, a play mode and a view mode.
- **Review and Results screens**: category-by-category review with 1 to 5 star ratings,
  plus a results screen with a lightbox.
- **Play screen**: timer, chat, done button and countdown while exploring the map.
- **Lobby and profiles**: profile and lobby screens in a dark theme.

### Fixed
- **Forged identities**: players can no longer fake another player's identity or take over
  their seat.
- **Maps consent**: Google's consent page is pre-answered or rejected automatically.
- **Avatars**: heads are centred in their ring.

## 2026-10-20

### Added
- **First release**: a Geobingo-style multiplayer party game for Electron. One player
  hosts a room, everyone explores an embedded Google or Apple Maps view to find a spot
  for each category, and the group rates the finds. Players connect peer to peer and no
  API key is needed.
