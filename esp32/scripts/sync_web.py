"""PlatformIO pre-script: mirror ../web/ into data/ so the LittleFS image
always matches the web app. data/ is generated — edit files in web/ only."""
import shutil
from pathlib import Path

Import("env")  # noqa: F821 (PlatformIO injects this)

project_dir = Path(env["PROJECT_DIR"])  # noqa: F821
web_dir = project_dir.parent / "web"
data_dir = project_dir / "data"

if data_dir.exists():
    shutil.rmtree(data_dir)
shutil.copytree(web_dir, data_dir)
print(f"sync_web: copied {web_dir} -> {data_dir}")
