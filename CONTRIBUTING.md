## Contributing

Hi there! We're thrilled that you'd like to contribute to this project. Your help is essential for keeping it great.

Contributions to this project are [released](https://docs.github.com/en/github/site-policy/github-terms-of-service#6-contributions-under-repository-license)
to the public under the [GPL-3.0 License](https://github.com/zoriya/Kyoo/blob/master/LICENSE).

## Submitting a pull request

1. [Fork](https://github.com/zoriya/Kyoo/fork) and clone the repository
2. Create a new branch: `git checkout -b my-branch-name`
3. Make your changes (Please try to follow the same coding style as what has already been made - indent with tabs, align with spaces etc).
Don't forget to run the auto-formatter.
4. Push to your fork and [submit a pull request](https://github.com/zoriya/Kyoo/compare)
5. Pat your self on the back and wait for your pull request to be reviewed and merged.

Here are a few things you can do that will increase the likelihood of your pull request being accepted:

- Make sure the `README.md` and any other relevant **documentation are kept up-to-date**.
- We try to follow [SemVer v2.0.0](https://semver.org/). Randomly breaking public APIs is not an option.
- Keep your change as focused as possible. If there are multiple changes you would like to make that are not dependent upon each other, consider submitting them as **separate pull requests**.
- Write a [good commit message](http://tbaggery.com/2008/04/19/a-note-about-git-commit-messages.html).

## Fork CI and releases (`lucanori/Kyoo`)

- **Container images and Helm chart**: default repositories in `docker-compose.yml` (`KYOO_IMAGE_REPO`, default `ghcr.io/lucanori`) and `chart/values.yaml` (`global.image.repositoryBase: "ghcr.io/lucanori"`) target this fork's GHCR namespace.
- **Image tag semantics**: pushes to `master` publish `edge` and `master`; pushes to `next` publish `next`; stable SemVer tags (`vX.Y.Z`) publish `X.Y.Z`, `X.Y`, and `latest`; prerelease SemVer tags publish only the exact stripped version (for example `1.2.3-rc.1`) with no `latest` or `X.Y`. Pull requests build without pushing.
- **Single-tag release fanout**: pushing a valid `v*` SemVer tag (without `+build` metadata) triggers `.github/workflows/release.yml`, which validates the tag, builds and pushes all five multiarch images with the exact stripped version, packages and pushes the Helm chart (`oci://ghcr.io/lucanori/helm-charts/kyoo`) with the same version, builds signed phone and TV APKs (`kyoo.apk` and `kyoo-tv.apk`), and publishes the GitHub Release with `docker-compose.yml` pinned to the exact version. The release fails if any APK or install file is missing. Invalid tags fail before any publication. GHCR packages are first created private by default, so public pulls may require a one-time package visibility change to public or an explicit access grant.
- **Manual Helm dispatch**: `.github/workflows/helm-release-chart.yml` accepts a valid SemVer `chart_version` (default `0.0.0-edge`) and `image_tag` (default `edge`) only on `workflow_dispatch`. Releases use the validated `inputs.version` instead.
- **Android package IDs and deep-link caveat**: fork builds use `dev.lucanori.kyoo` (and `dev.lucanori.kyoo.dev` for development) while keeping the shared `kyoo` deep-link scheme for upstream OIDC compatibility. If both upstream (`dev.zoriya.kyoo`) and fork (`dev.lucanori.kyoo`) apps are installed on the same device, `kyoo://` OIDC callbacks may prompt or route ambiguously.
- **Optional integrations**: Chromecast GitHub Pages deployment is optional via the `ENABLE_CHROMECAST_PAGES` variable. Google Play and Expo OTA workflows are upstream-only references and stay disabled on this fork. Do not set `ENABLE_GOOGLE_PLAY` or `ENABLE_EXPO_UPDATE` for this fork.

## Resources

- [Why should you indent with tabs](https://www.reddit.com/r/javascript/comments/c8drjo/nobody_talks_about_the_real_reason_to_use_tabs/)
- [How to Contribute to Open Source](https://opensource.guide/how-to-contribute/)
- [Using Pull Requests](https://docs.github.com/en/github/collaborating-with-issues-and-pull-requests/about-pull-requests)
- [GitHub Help](https://docs.github.com/en)
