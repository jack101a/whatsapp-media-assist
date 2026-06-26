# Media Assist 1.4.0

- switched the licensing server to SQLite/WAL and one Docker container
- added email-OTP settings/pipeline sync with revisions and retry state
- enforced one active device per account
- added online entitlement verification before each paid pipeline execution
- retained only a short signed entitlement cache for UI status
- made the WhatsApp toolbar smaller and reserved space for official controls
- improved media-viewer detection and toolbar stability
- moved merge/PDF work to a short-lived extension-origin processor
- added processor timeout and immediate cleanup after completed merge exports
- improved the light Options account, sync and privacy sections
- added SQLite migrations, sync tests, device-revocation tests and online backup/restore
