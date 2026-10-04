# Gym Tracker

A tiny, fast gym logger. Type a kg value and press Enter, and the date is filled in for you.

- **App** (this repo, public): static HTML, CSS and JS served by GitHub Pages. It holds no data.
- **Data** (`gym-data` repo, **private**): a single `data.json`, read and written through the GitHub API.
  Every save is a commit, so you get full history and backups.

## Use
- **Add an exercise:** type the name, press Enter, sets, Enter, reps, Enter, kg, Enter. Blank sets or reps default to 3×8.
- **Log a weight:** type the kg in the exercise's row and press Enter. Pressing Enter on an empty box logs the same weight as last time.
  Logging the same exercise twice on one day overwrites that day's entry.
- **History and chart:** tap the exercise name.
- **Offline:** changes are saved on the phone and sync when you're back online. The header shows the sync status.

## Connect a device
1. Create a fine-grained token: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens.
   - Repository access: **Only select repositories → `gym-data`**
   - Permissions: **Contents → Read and write**
2. Open the app, tap ⚙, then enter your username, `gym-data`, and the token. Tap **Save & sync**.
3. Add it to your home screen from the browser's Share menu.

The token is kept only in that device's browser storage. The app loads no third-party scripts.
