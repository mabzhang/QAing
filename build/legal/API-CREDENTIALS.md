# API credentials

The QAing public package contains no default, shared, developer-owned, or
embedded API credentials.

DeepSeek and Doubao SeedASR integrations remain available, but each user must
enter credentials issued by their own provider account in QAing Settings. Those
credentials are stored locally through the application's macOS secure-storage
boundary and are never copied into the source tree or application bundle.

Provider host names, WebSocket paths, model IDs, and public resource IDs in the
source code are protocol configuration, not authentication credentials.
