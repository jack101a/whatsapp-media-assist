from __future__ import annotations

import glob
import os
import sqlite3
import threading
import time
import subprocess
import tempfile
from datetime import datetime, timezone
import logging
import httpx

logger = logging.getLogger("media_assist.backups")

# Global event to stop the scheduler thread
stop_event = threading.Event()
scheduler_thread: threading.Thread | None = None


def get_system_setting(key: str, default: str = "") -> str:
    """Safely retrieves a configuration value from the system_settings table."""
    from .db import SessionLocal
    from .models import SystemSetting
    db = SessionLocal()
    try:
        setting = db.get(SystemSetting, key)
        return setting.value if setting else default
    except Exception as exc:
        logger.warning(f"Failed to fetch system setting '{key}': {exc}")
        return default
    finally:
        db.close()


def get_db_path() -> str:
    """Dynamically resolves the absolute path to the active SQLite database file."""
    from urllib.parse import urlparse
    from .config import get_settings
    db_url = get_settings().database_url
    
    parsed = urlparse(db_url)
    path = parsed.path
    
    # On Windows, replace forward slashes with backslashes and strip UNC prefix slashes
    if os.name == 'nt':
        path = path.replace('/', '\\')
        while path.startswith('\\\\'):
            path = path[1:]
            
    # Strip leading slash on Windows drive paths like /C:/
    if len(path) > 2 and path[0] == '\\' and path[2] == ':':
        path = path[1:]
    elif len(path) > 2 and path[0] == '/' and path[2] == ':':
        path = path[1:]
        
    return os.path.abspath(path)


def get_backup_dir() -> str:
    """Dynamically resolves the absolute path to the database backups directory."""
    db_path = get_db_path()
    return os.path.join(os.path.dirname(db_path), "backups")


def upload_to_telegram(filepath: str) -> None:
    """Uploads a backup snapshot file to the configured Telegram chat."""
    token = get_system_setting("telegram_bot_token")
    chat_id = get_system_setting("telegram_chat_id")
    if not token or not chat_id:
        logger.info("Telegram backup dump skipped: Bot Token or Chat ID not configured.")
        return

    url = f"https://api.telegram.org/bot{token}/sendDocument"
    filename = os.path.basename(filepath)
    logger.info(f"Uploading backup dump '{filename}' to Telegram chat '{chat_id}'")
    
    try:
        with open(filepath, "rb") as f:
            files = {"document": (filename, f)}
            data = {"chat_id": chat_id, "caption": f"💾 Media Assist Auto Snapshot Backup\n📅 Timestamp: {datetime.now(timezone.utc).isoformat()}"}
            # Execute synchronous HTTP request with a generous timeout
            res = httpx.post(url, data=data, files=files, timeout=60.0)
            if res.status_code != 200:
                logger.error(f"Telegram Bot API failed (status {res.status_code}): {res.text}")
            else:
                logger.info("Telegram database backup dump sent successfully.")
    except Exception as exc:
        logger.error(f"Failed to transmit backup snapshot to Telegram: {exc}")


def rclone_copy_to_remote(filepath: str) -> None:
    """Copies a backup snapshot to the configured Rclone cloud storage remote."""
    remote_path = get_system_setting("rclone_remote_path")
    if not remote_path:
        logger.info("Rclone backup copy skipped: Rclone Remote Path not configured.")
        return

    config_content = get_system_setting("rclone_config")
    config_file = None
    
    try:
        # Write config to a temporary file if loaded from DB
        if config_content.strip():
            fd, config_file = tempfile.mkstemp(suffix=".conf", prefix="rclone-")
            os.write(fd, config_content.encode('utf-8'))
            os.close(fd)
            
        cmd = ["rclone"]
        if config_file:
            cmd.extend(["--config", config_file])
        cmd.extend(["copy", filepath, remote_path])
        
        logger.info(f"Executing Rclone upload command: {' '.join(cmd)}")
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=120.0)
        
        if res.returncode != 0:
            logger.error(f"Rclone copy failed (exit code {res.returncode}): {res.stderr}")
            raise RuntimeError(f"Rclone execution error: {res.stderr}")
        else:
            logger.info("Rclone backup copy sync completed successfully.")
    except Exception as exc:
        logger.error(f"Failed to synchronize backup to Rclone remote: {exc}")
        raise exc
    finally:
        if config_file and os.path.exists(config_file):
            try:
                os.remove(config_file)
            except Exception:
                pass


def rclone_download_from_remote(filename: str, local_dest_dir: str) -> None:
    """Downloads a backup snapshot from the cloud remote back to the local backup directory."""
    remote_path = get_system_setting("rclone_remote_path")
    if not remote_path:
        raise ValueError("Rclone Remote Path is not configured.")

    config_content = get_system_setting("rclone_config")
    config_file = None
    
    try:
        if config_content.strip():
            fd, config_file = tempfile.mkstemp(suffix=".conf", prefix="rclone-")
            os.write(fd, config_content.encode('utf-8'))
            os.close(fd)
            
        remote_filepath = f"{remote_path.rstrip('/')}/{filename}"
        cmd = ["rclone"]
        if config_file:
            cmd.extend(["--config", config_file])
        cmd.extend(["copy", remote_filepath, local_dest_dir])
        
        logger.info(f"Executing Rclone restore download command: {' '.join(cmd)}")
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=120.0)
        
        if res.returncode != 0:
            logger.error(f"Rclone download failed (exit code {res.returncode}): {res.stderr}")
            raise RuntimeError(f"Rclone download execution error: {res.stderr}")
        else:
            logger.info("Rclone restore snapshot downloaded successfully.")
    except Exception as exc:
        logger.error(f"Failed to download snapshot from Rclone remote: {exc}")
        raise exc
    finally:
        if config_file and os.path.exists(config_file):
            try:
                os.remove(config_file)
            except Exception:
                pass


def run_external_backup_syncs(filepath: str) -> None:
    """Triggers off-site backup transfers in the background to avoid blocking API threads."""
    logger.info("Starting background off-site backups transmission.")
    upload_to_telegram(filepath)
    try:
        rclone_copy_to_remote(filepath)
    except Exception:
        pass


def take_database_backup() -> str:
    """Takes a consistent hot snapshot of the active SQLite database in WAL mode."""
    db_path = get_db_path()
    backup_dir = get_backup_dir()
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_file = f"media-assist-{stamp}.db"
    backup_path = os.path.join(backup_dir, backup_file)

    logger.info(f"Initiating SQLite snapshot backup to: {backup_path}")
    
    # Connect to the live database in read-only mode to prevent write locks
    src_conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    dst_conn = sqlite3.connect(backup_path)

    try:
        # Run integrity check on the source database before copying
        integrity = src_conn.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise ValueError(f"Active database integrity check failed: {integrity}")

        # Atomically backup pages from live database to backup snapshot file
        src_conn.backup(dst_conn)
        logger.info("SQLite snapshot backup completed successfully.")
    except Exception as exc:
        logger.error(f"Failed to execute database backup: {exc}")
        if os.path.exists(backup_path):
            try:
                os.remove(backup_path)
            except Exception:
                pass
        raise exc
    finally:
        src_conn.close()
        dst_conn.close()

    # Clean up older backups, keeping only snapshots matching the rotation policy
    cleanup_old_backups()
    
    # Run Telegram and Rclone off-site uploads in the background
    threading.Thread(
        target=run_external_backup_syncs,
        args=(backup_path,),
        name="OffsiteBackupsSync",
        daemon=True
    ).start()
    
    return backup_path


def restore_database_backup(filename: str) -> None:
    """Live restores database pages from a snapshot directly into the active SQLite DB."""
    db_path = get_db_path()
    backup_dir = get_backup_dir()
    backup_path = os.path.join(backup_dir, filename)
    
    # If the backup doesn't exist locally, try downloading it from the Rclone remote
    if not os.path.exists(backup_path):
        logger.info(f"Snapshot file '{filename}' not found locally. Attempting remote pull via Rclone...")
        try:
            rclone_download_from_remote(filename, backup_dir)
        except Exception as exc:
            raise FileNotFoundError(
                f"Snapshot file '{filename}' is missing locally and could not be retrieved from Rclone: {exc}"
            ) from exc

    logger.warning(f"Initiating live database restore from: {backup_path}")

    src_conn = sqlite3.connect(f"file:{backup_path}?mode=ro", uri=True)
    
    # Open target connection with a high timeout to handle potential lock queues
    dst_conn = sqlite3.connect(db_path, timeout=30.0)

    try:
        # Verify the backup integrity before loading it into the live database
        integrity = src_conn.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise ValueError(f"Backup snapshot integrity check failed: {integrity}")

        # Safe live restore: copy database pages from snapshot to active file
        src_conn.backup(dst_conn)
        
        # Re-ensure standard optimization PRAGMAs on target
        dst_conn.execute("PRAGMA journal_mode=WAL")
        dst_conn.execute("PRAGMA foreign_keys=ON")
        
        logger.warning("Database live restore completed successfully.")
    except Exception as exc:
        logger.error(f"Critical error during database restore: {exc}")
        raise exc
    finally:
        src_conn.close()
        dst_conn.close()


def cleanup_old_backups() -> None:
    """Retains only the latest backups matching rotation limits (count and total size)."""
    try:
        # Load rotation rules from system settings
        max_count = int(get_system_setting("max_backup_count", "14"))
        max_size_mb = int(get_system_setting("max_backup_size_mb", "100"))
        
        backup_dir = get_backup_dir()
        backups = glob.glob(os.path.join(backup_dir, "media-assist-*.db"))
        
        # Map to (filepath, mtime, size)
        backup_stats = []
        for filepath in backups:
            stat = os.stat(filepath)
            backup_stats.append((filepath, stat.st_mtime, stat.st_size))
            
        # Sort by creation date (mtime) ascending (oldest first)
        backup_stats.sort(key=lambda x: x[1])
        
        # 1. Prune by maximum count
        while len(backup_stats) > max_count:
            oldest = backup_stats.pop(0)
            try:
                os.remove(oldest[0])
                logger.info(f"Rotation pruned (count limit): {oldest[0]}")
            except Exception as e:
                logger.warning(f"Prune failed for {oldest[0]}: {e}")
                
        # 2. Prune by maximum size limit in MB
        total_size = sum(x[2] for x in backup_stats)
        max_size_bytes = max_size_mb * 1024 * 1024
        
        while total_size > max_size_bytes and backup_stats:
            oldest = backup_stats.pop(0)
            try:
                os.remove(oldest[0])
                total_size -= oldest[2]
                logger.info(f"Rotation pruned (size limit {max_size_mb}MB): {oldest[0]}")
            except Exception as e:
                logger.warning(f"Prune failed for {oldest[0]}: {e}")
                
    except Exception as exc:
        logger.warning(f"Failed to complete backup rotation cleanup: {exc}")


def list_backups() -> list[dict]:
    """Lists all available backups with sizes and creation dates."""
    backup_dir = get_backup_dir()
    os.makedirs(backup_dir, exist_ok=True)
    output = []
    backups = glob.glob(os.path.join(backup_dir, "media-assist-*.db"))
    for filepath in backups:
        filename = os.path.basename(filepath)
        stat = os.stat(filepath)
        # Parse stamp YYYYMMDDTHHMMSSZ
        created_at = None
        if filename.startswith("media-assist-") and filename.endswith(".db"):
            stamp_str = filename[len("media-assist-"):-len(".db")]
            try:
                created_at = datetime.strptime(stamp_str, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
            except ValueError:
                pass
        
        if created_at is None:
            created_at = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)

        output.append({
            "filename": filename,
            "size_bytes": stat.st_size,
            "created_at": created_at
        })
    # Sort newest first
    output.sort(key=lambda x: x["created_at"], reverse=True)
    return output


def _scheduler_loop() -> None:
    """Background loop that ensures one automatic snapshot backup is taken every 24 hours."""
    logger.info("Automatic backup scheduler thread started.")
    # Wait 30 seconds before the first check to let the main application initialize
    time.sleep(30.0)
    while not stop_event.is_set():
        try:
            enabled = get_system_setting("auto_backup_enabled", "true").lower() == "true"
            if enabled:
                backups = list_backups()
                should_backup = True
                if backups:
                    latest = backups[0]
                    elapsed = (datetime.now(timezone.utc) - latest["created_at"]).total_seconds()
                    # 24 hours = 86400 seconds
                    if elapsed < 86400:
                        should_backup = False
                
                if should_backup:
                    logger.info("Auto-backup interval reached (24 hours). Creating snapshot.")
                    take_database_backup()
            else:
                logger.debug("Auto-backup is disabled in settings.")
        except Exception as exc:
            logger.error(f"Error in automatic backup scheduler loop: {exc}")

        # Sleep for 1 hour (3600 seconds), checking stop_event periodically
        for _ in range(360):
            if stop_event.is_set():
                break
            time.sleep(10.0)


def start_backup_scheduler() -> None:
    """Launches the automatic backup scheduler thread."""
    global scheduler_thread
    if scheduler_thread is not None:
        return
    stop_event.clear()
    scheduler_thread = threading.Thread(target=_scheduler_loop, name="BackupScheduler", daemon=True)
    scheduler_thread.start()


def stop_backup_scheduler() -> None:
    """Stops the automatic backup scheduler thread."""
    global scheduler_thread
    if scheduler_thread is None:
        return
    stop_event.set()
    scheduler_thread = None
    logger.info("Automatic backup scheduler stop signal sent.")
