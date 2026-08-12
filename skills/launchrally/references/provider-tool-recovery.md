# Provider Tool Recovery

Use this route only for an item in `report.results.provider_tool_recoveries` or a targeted Verify item's `targeted_result.provider_tool_recoveries`. Require `schema_version: "launchrally.dev/provider-tool-recovery/v1"` and validate the complete object before presenting it.

1. Present the Provider, Adapter version, executable, detected state, evidence benefit, official source, exact supported version, verification command, active platform and shell, and only the returned choices. Keep `continue_with_gap` as the default.
2. For `continue_with_gap`, preserve the original `missing_provider_tool` or `missing_provider_login` Verification Gap and complete the current Audit or Verify result unchanged.
3. For `show_install_instructions`, run `rally providers --report <saved-report> --recover <provider> --choice show_install_instructions --json`. Render only `recovery.installation_instructions[].command` from the response. The user executes any installation command; the Agent waits. If `active_environment.guidance_available` is false, present that typed state and offer only the remaining returned choices.
4. After the user reports installation and verification complete, run the same recovery operation with `--choice rediscover_executable`. LaunchRally may execute only `installation_authority.verification_command` to rediscover the executable and exact version. It executes no installation command.
5. For `unsupported_version`, present the detected and exact supported versions, then return to the response choices. For `unauthenticated`, preserve `missing_provider_login` and stop this recovery route; authentication remains a separate user-managed Provider action.
6. For `ready_for_fresh_permission`, start a new Audit or Verify collection boundary. Present the new `provider_read:<provider>` request and wait for an explicit decision. The earlier approval never carries forward. Collect only after this fresh approval; denial preserves the Gap.
7. For `cancel`, stop only this recovery route. Keep the Report, Evidence, Check status, and original Verification Gap unchanged.

Treat command objects as executable plus argv with `shell: false`. Never derive an install command, version, source, platform claim, login step, or permission decision from prose. This recovery route is stateless and uses the saved typed Report; it requires no resume-token transfer.
