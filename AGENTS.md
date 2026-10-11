<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture
- Trading engine and Deriv socket live as browser singletons in src/lib (engine.ts, deriv.ts) with a tiny external store (store.ts) so trading keeps running across tab navigation.
- Stake math lives in src/lib/martingale.ts as pure functions so it stays unit-tested.
- Per-user settings and trades sync to Lovable Cloud via src/lib/cloud.ts subscribing to the store; localStorage stays as offline cache.
