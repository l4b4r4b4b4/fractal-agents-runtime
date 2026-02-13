"""Unit tests for the database module.

These tests verify the database module's behavior WITHOUT requiring a
running Postgres instance. They test initialization guards, accessor
defaults, and shutdown safety.

For integration tests that require Postgres, see ``test_postgres_integration.py``.
"""

import pytest

from server.database import (
    get_checkpointer,
    get_pool,
    get_store,
    is_postgres_enabled,
    shutdown_database,
)


class TestDatabaseAccessorsBeforeInit:
    """Test that all accessors return safe defaults before initialization."""

    def test_is_postgres_enabled_false_by_default(self):
        """is_postgres_enabled() returns False before initialization."""
        # Note: This test assumes the module hasn't been initialized
        # in this test process. Other tests should call shutdown_database()
        # in teardown to reset state.
        assert is_postgres_enabled() is False

    def test_get_pool_none_without_init(self):
        """get_pool() returns None before initialization."""
        assert get_pool() is None

    def test_get_checkpointer_none_without_init(self):
        """get_checkpointer() returns None before initialization."""
        assert get_checkpointer() is None

    def test_get_store_none_without_init(self):
        """get_store() returns None before initialization."""
        assert get_store() is None


class TestShutdownSafety:
    """Test that shutdown is safe to call in any state."""

    @pytest.mark.asyncio
    async def test_shutdown_without_init(self):
        """shutdown_database() is safe to call before initialization."""
        # Should not raise
        await shutdown_database()

    @pytest.mark.asyncio
    async def test_shutdown_twice(self):
        """shutdown_database() is safe to call multiple times."""
        await shutdown_database()
        await shutdown_database()

    @pytest.mark.asyncio
    async def test_shutdown_resets_state(self):
        """shutdown_database() resets all module-level singletons."""
        await shutdown_database()
        assert is_postgres_enabled() is False
        assert get_pool() is None
        assert get_checkpointer() is None
        assert get_store() is None


class TestInitializeWithoutDatabaseUrl:
    """Test initialization behavior when DATABASE_URL is not set."""

    @pytest.mark.asyncio
    async def test_initialize_returns_false_without_url(self, monkeypatch):
        """initialize_database() returns False when DATABASE_URL is empty."""
        from server import database as db_module
        from server.config import (
            Config,
            DatabaseConfig,
            LLMConfig,
            ServerConfig,
            SupabaseConfig,
        )

        # Create a config with empty database URL
        mock_config = Config(
            server=ServerConfig(),
            supabase=SupabaseConfig(),
            llm=LLMConfig(),
            database=DatabaseConfig(url=""),
        )

        # Patch get_config to return our mock config
        monkeypatch.setattr("server.config._config", mock_config)

        # Reset database state
        db_module._pool = None
        db_module._checkpointer = None
        db_module._store = None
        db_module._initialized = False

        try:
            result = await db_module.initialize_database()
            assert result is False
            assert is_postgres_enabled() is False
            assert get_pool() is None
            assert get_checkpointer() is None
            assert get_store() is None
        finally:
            # Clean up
            monkeypatch.setattr("server.config._config", None)
            db_module._initialized = False

    @pytest.mark.asyncio
    async def test_initialize_returns_false_with_unreachable_host(self, monkeypatch):
        """initialize_database() returns False for unreachable Postgres host."""
        from server import database as db_module
        from server.config import (
            Config,
            DatabaseConfig,
            LLMConfig,
            ServerConfig,
            SupabaseConfig,
        )

        # Create a config with an unreachable database URL
        mock_config = Config(
            server=ServerConfig(),
            supabase=SupabaseConfig(),
            llm=LLMConfig(),
            database=DatabaseConfig(
                url="postgresql://postgres:postgres@192.0.2.1:5432/nonexistent",
                pool_timeout=2.0,
            ),
        )

        monkeypatch.setattr("server.config._config", mock_config)

        db_module._pool = None
        db_module._checkpointer = None
        db_module._store = None
        db_module._initialized = False

        try:
            result = await db_module.initialize_database()
            assert result is False
            assert is_postgres_enabled() is False
            # Should have cleaned up after failure
            assert get_pool() is None
            assert get_checkpointer() is None
            assert get_store() is None
        finally:
            monkeypatch.setattr("server.config._config", None)
            db_module._initialized = False


class TestDatabaseConfig:
    """Test DatabaseConfig dataclass behavior."""

    def test_default_values(self):
        """DatabaseConfig has sensible defaults."""
        from server.config import DatabaseConfig

        config = DatabaseConfig()
        assert config.url == ""
        assert config.pool_min_size == 2
        assert config.pool_max_size == 10
        assert config.pool_timeout == 30.0

    def test_is_configured_false_when_empty(self):
        """is_configured returns False when URL is empty."""
        from server.config import DatabaseConfig

        config = DatabaseConfig(url="")
        assert config.is_configured is False

    def test_is_configured_true_when_set(self):
        """is_configured returns True when URL is provided."""
        from server.config import DatabaseConfig

        config = DatabaseConfig(url="postgresql://localhost/test")
        assert config.is_configured is True

    def test_from_env_with_defaults(self, monkeypatch):
        """from_env() uses defaults when env vars are not set."""
        from server.config import DatabaseConfig

        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.delenv("DATABASE_POOL_MIN_SIZE", raising=False)
        monkeypatch.delenv("DATABASE_POOL_MAX_SIZE", raising=False)
        monkeypatch.delenv("DATABASE_POOL_TIMEOUT", raising=False)

        config = DatabaseConfig.from_env()
        assert config.url == ""
        assert config.pool_min_size == 2
        assert config.pool_max_size == 10
        assert config.pool_timeout == 30.0

    def test_from_env_reads_env_vars(self, monkeypatch):
        """from_env() reads configuration from environment variables."""
        from server.config import DatabaseConfig

        monkeypatch.setenv("DATABASE_URL", "postgresql://test:5432/db")
        monkeypatch.setenv("DATABASE_POOL_MIN_SIZE", "5")
        monkeypatch.setenv("DATABASE_POOL_MAX_SIZE", "20")
        monkeypatch.setenv("DATABASE_POOL_TIMEOUT", "60.0")

        config = DatabaseConfig.from_env()
        assert config.url == "postgresql://test:5432/db"
        assert config.pool_min_size == 5
        assert config.pool_max_size == 20
        assert config.pool_timeout == 60.0


class TestLanggraphTablesList:
    """Test the _LANGGRAPH_TABLES constant."""

    def test_langgraph_tables_contains_expected_tables(self):
        """_LANGGRAPH_TABLES lists all LangGraph-managed tables."""
        from server.database import _LANGGRAPH_TABLES

        expected = {
            "checkpoints",
            "checkpoint_blobs",
            "checkpoint_writes",
            "checkpoint_migrations",
            "store",
            "store_migrations",
        }
        assert set(_LANGGRAPH_TABLES) == expected

    def test_langgraph_tables_is_tuple(self):
        """_LANGGRAPH_TABLES is immutable (tuple, not list)."""
        from server.database import _LANGGRAPH_TABLES

        assert isinstance(_LANGGRAPH_TABLES, tuple)


class TestStorageFallback:
    """Test that get_storage() falls back to in-memory when Postgres is disabled."""

    def test_get_storage_returns_in_memory_without_postgres(self):
        """get_storage() returns in-memory Storage when Postgres is not enabled."""
        from server.storage import Storage, get_storage, reset_storage

        # Reset to force re-evaluation
        reset_storage()

        try:
            storage = get_storage()
            assert isinstance(storage, Storage)
        finally:
            reset_storage()

    def test_reset_storage_clears_singleton(self):
        """reset_storage() clears the global storage instance."""
        from server.storage import get_storage, reset_storage

        storage_first = get_storage()
        reset_storage()
        storage_second = get_storage()

        # Should be different instances after reset
        assert storage_first is not storage_second
        reset_storage()
