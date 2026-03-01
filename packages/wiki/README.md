# Zajel Wiki

This package contains the GitHub Wiki content for the Zajel project.

## How to Push to GitHub Wiki

GitHub Wikis have their own git repository at `https://github.com/<owner>/<repo>.wiki.git`.

### First-time setup

1. Enable the Wiki on your GitHub repository (Settings > Features > Wiki).
2. Create at least one page through the GitHub UI to initialize the wiki repo.

### Deploying wiki content

```bash
# Option 1: All-in-one deploy (clone, copy, commit, push)
npm run deploy

# Option 2: Step by step
npm run clone          # Clone the wiki repo into _wiki_repo/
npm run sync           # Copy all .md files into the cloned repo
# Review changes in _wiki_repo/
npm run push           # Commit and push to GitHub

# Cleanup
npm run clean          # Remove the cloned wiki repo
```

### Manual deployment

```bash
# Clone the wiki repo
git clone https://github.com/nicekid1/Zajel.wiki.git _wiki_repo

# Copy all markdown files
cp *.md _wiki_repo/

# Push
cd _wiki_repo
git add -A
git commit -m "Update wiki content"
git push
```

## File Structure

- `Home.md` -- Landing page (shown when visiting the wiki)
- `_Sidebar.md` -- Navigation sidebar (shown on every page)
- `_Footer.md` -- Footer (shown on every page)
- `Architecture-Overview.md` -- System architecture and tech stack
- `Connection-Lifecycle.md` -- Pairing, reconnection, and connection states
- `Security-Architecture.md` -- Encryption, key management, and threat model
- `Privacy-Model.md` -- Zero-knowledge design and data flow
- `Channels-Architecture.md` -- Broadcast channels with Ed25519 signing
- `Groups-Architecture.md` -- Group messaging with sender keys
- `VoIP-Architecture.md` -- Voice/video call setup and media
- `Server-Architecture.md` -- Cloudflare Workers and Durable Objects
- `Data-Storage.md` -- SQLite, secure storage, and data lifecycle
- `App-Attestation.md` -- Device attestation and anti-tamper
- `Build-and-Deploy.md` -- Build targets, CI/CD, and deployment
- `Feature-Reference.md` -- Complete feature list
- `Code-Index.md` -- Feature-to-code mapping for developers
