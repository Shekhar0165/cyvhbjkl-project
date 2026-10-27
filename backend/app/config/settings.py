from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_path: str = "/app/data/app.db"
    cors_origins: str = "http://localhost:5173"
    default_cutoff_utc: str = Field(default="10:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    app_version: str = "1.0.0"
    log_level: str = "INFO"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


settings = Settings()
