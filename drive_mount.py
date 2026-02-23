# drive_mount.py - Secure network drive mounting with cleanup
import subprocess
import os
import tempfile
import logging
from typing import Optional, List, Tuple, Dict  # Added Dict here
from pathlib import Path
import platform
import time

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class DriveMount:
    """Mount network drives (SMB/CIFS) with robust error handling and security."""
    
    # Constants
    MOUNT_TIMEOUT = 30  # seconds
    MAX_MOUNT_ATTEMPTS = 3
    
    @staticmethod
    def _validate_mount_inputs(server: str, share: str, mount_point: str,
                               username: str) -> Tuple[bool, str]:
        """Validate mount parameters."""
        # Validate server
        if not server or not server.strip():
            return False, "Server address cannot be empty"
        
        # Basic server format validation
        if any(c in server for c in ['|', ';', '&', '`', '$', '\n']):
            return False, "Invalid characters in server address"
        
        # Validate share
        if not share or not share.strip():
            return False, "Share name cannot be empty"
        
        if any(c in share for c in ['|', ';', '&', '`', '$', '\n']):
            return False, "Invalid characters in share name"
        
        # Validate mount point
        if not mount_point or not mount_point.strip():
            return False, "Mount point cannot be empty"
        
        mount_path = Path(mount_point)
        
        # Check for suspicious paths
        dangerous_paths = ['/etc', '/sys', '/proc', '/boot', '/root', '/bin', '/sbin']
        if any(str(mount_path).startswith(p) for p in dangerous_paths):
            return False, f"Cannot mount to system directory: {mount_point}"
        
        # Validate username
        if not username or not username.strip():
            return False, "Username cannot be empty"
        
        return True, "OK"
    
    @staticmethod
    def _create_mount_point(mount_point: str) -> Tuple[bool, str]:
        """Create mount point directory if it doesn't exist."""
        try:
            path = Path(mount_point)
            path.mkdir(parents=True, exist_ok=True)
            
            # Set appropriate permissions
            try:
                os.chmod(mount_point, 0o755)
            except:
                pass  # Best effort
            
            logger.info(f"Mount point ready: {mount_point}")
            return True, "OK"
        
        except PermissionError:
            return False, f"Permission denied creating mount point: {mount_point}"
        except Exception as e:
            return False, f"Failed to create mount point: {str(e)}"
    
    @staticmethod
    def _is_already_mounted(mount_point: str) -> bool:
        """Check if a path is already mounted."""
        try:
            result = subprocess.run(
                ["mount"],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            mount_point_resolved = str(Path(mount_point).resolve())
            for line in result.stdout.splitlines():
                if mount_point_resolved in line:
                    logger.info(f"Path already mounted: {mount_point}")
                    return True
            
            return False
        except:
            return False
    
    @staticmethod
    def mount_smb(server: str, share: str, mount_point: str,
                  username: str, password: str, domain: str = "",
                  read_only: bool = False) -> Tuple[bool, str]:
        """
        Mount SMB/CIFS share with comprehensive error handling.
        
        Args:
            server: Server address (e.g., "192.168.1.100" or "nas.example.com")
            share: Share name (e.g., "photos")
            mount_point: Local mount point (e.g., "/mnt/nas_photos")
            username: Username
            password: Password
            domain: Domain (optional)
            read_only: Mount as read-only
        
        Returns:
            (success, message)
        """
        # Validate inputs
        valid, msg = DriveMount._validate_mount_inputs(server, share, mount_point, username)
        if not valid:
            return False, msg
        
        # Check if already mounted
        if DriveMount._is_already_mounted(mount_point):
            return True, f"✅ Already mounted at {mount_point}"
        
        # Create mount point
        success, msg = DriveMount._create_mount_point(mount_point)
        if not success:
            return False, msg
        
        # Determine OS
        system = platform.system()
        logger.info(f"Mounting on {system} system")
        
        credentials_file = None
        
        try:
            if system == 'Darwin':  # macOS
                return DriveMount._mount_smb_macos(
                    server, share, mount_point, username, password, domain, read_only
                )
            
            elif system == 'Linux':
                return DriveMount._mount_smb_linux(
                    server, share, mount_point, username, password, domain, read_only
                )
            
            else:
                return False, f"Unsupported operating system: {system}"
        
        finally:
            # Cleanup credentials file if created
            if credentials_file and os.path.exists(credentials_file):
                try:
                    os.unlink(credentials_file)
                    logger.info("Cleaned up credentials file")
                except:
                    pass
    
    @staticmethod
    def _mount_smb_macos(server: str, share: str, mount_point: str,
                        username: str, password: str, domain: str,
                        read_only: bool) -> Tuple[bool, str]:
        """Mount SMB on macOS using mount_smbfs."""
        # Build credentials string
        if domain:
            credentials = f"{domain};{username}:{password}"
        else:
            credentials = f"{username}:{password}"
        
        # Escape special characters in password
        credentials = credentials.replace('@', '%40')
        
        # Build URL
        url = f"smb://{credentials}@{server}/{share}"
        
        # Build mount command
        cmd = ["mount", "-t", "smbfs"]
        
        if read_only:
            cmd.extend(["-o", "rdonly"])
        
        cmd.extend([url, mount_point])
        
        # Execute
        try:
            logger.info(f"Executing mount command (macOS)")
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=DriveMount.MOUNT_TIMEOUT
            )
            
            if result.returncode == 0:
                logger.info(f"Successfully mounted {server}/{share}")
                return True, f"✅ Mounted {server}/{share} at {mount_point}"
            else:
                error_msg = result.stderr.strip() or result.stdout.strip()
                logger.error(f"Mount failed: {error_msg}")
                
                # Parse common errors
                if "Authentication error" in error_msg or "permission" in error_msg.lower():
                    return False, "❌ Authentication failed. Check username/password."
                elif "No such file" in error_msg or "does not exist" in error_msg:
                    return False, f"❌ Share not found: {server}/{share}"
                else:
                    return False, f"❌ Mount failed: {error_msg}"
        
        except subprocess.TimeoutExpired:
            logger.error("Mount command timeout")
            return False, f"❌ Mount timeout ({DriveMount.MOUNT_TIMEOUT}s). Check network connectivity."
        
        except Exception as e:
            logger.error(f"Unexpected error during mount: {e}")
            return False, f"❌ Error: {str(e)}"
    
    @staticmethod
    def _mount_smb_linux(server: str, share: str, mount_point: str,
                        username: str, password: str, domain: str,
                        read_only: bool) -> Tuple[bool, str]:
        """Mount SMB on Linux using mount.cifs."""
        credentials_file = None
        
        try:
            # Create temporary credentials file
            with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.creds') as f:
                credentials_file = f.name
                f.write(f"username={username}\n")
                f.write(f"password={password}\n")
                if domain:
                    f.write(f"domain={domain}\n")
            
            # Set secure permissions
            os.chmod(credentials_file, 0o600)
            
            # Build mount options
            mount_opts = [
                f"credentials={credentials_file}",
                f"uid={os.getuid()}",
                f"gid={os.getgid()}",
                "file_mode=0644",
                "dir_mode=0755"
            ]
            
            if read_only:
                mount_opts.append("ro")
            
            mount_opts_str = ",".join(mount_opts)
            
            # Build mount command
            cmd = [
                "sudo", "mount", "-t", "cifs",
                f"//{server}/{share}",
                mount_point,
                "-o", mount_opts_str
            ]
            
            # Execute
            logger.info(f"Executing mount command (Linux)")
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=DriveMount.MOUNT_TIMEOUT
            )
            
            if result.returncode == 0:
                logger.info(f"Successfully mounted {server}/{share}")
                return True, f"✅ Mounted {server}/{share} at {mount_point}"
            else:
                error_msg = result.stderr.strip() or result.stdout.strip()
                logger.error(f"Mount failed: {error_msg}")
                
                # Parse common errors
                if "Permission denied" in error_msg or "wrong fs type" in error_msg:
                    return False, "❌ Authentication failed or CIFS not supported."
                elif "No such file" in error_msg or "does not exist" in error_msg:
                    return False, f"❌ Share not found: {server}/{share}"
                elif "mount.cifs" not in error_msg and "sudo" in error_msg:
                    return False, "❌ Requires sudo privileges. Ensure user has permission."
                else:
                    return False, f"❌ Mount failed: {error_msg}"
        
        except subprocess.TimeoutExpired:
            logger.error("Mount command timeout")
            return False, f"❌ Mount timeout ({DriveMount.MOUNT_TIMEOUT}s)"
        
        except Exception as e:
            logger.error(f"Unexpected error during mount: {e}")
            return False, f"❌ Error: {str(e)}"
        
        finally:
            # Cleanup credentials file
            if credentials_file and os.path.exists(credentials_file):
                try:
                    os.unlink(credentials_file)
                    logger.info("Cleaned up credentials file")
                except Exception as e:
                    logger.warning(f"Failed to cleanup credentials file: {e}")
    
    @staticmethod
    def unmount(mount_point: str, force: bool = False) -> Tuple[bool, str]:
        """
        Unmount a drive.
        
        Args:
            mount_point: Path to unmount
            force: Force unmount (may cause data loss)
        
        Returns:
            (success, message)
        """
        if not mount_point or not mount_point.strip():
            return False, "Mount point cannot be empty"
        
        # Check if mounted
        if not DriveMount._is_already_mounted(mount_point):
            return False, f"⚠️  Path not mounted: {mount_point}"
        
        system = platform.system()
        
        try:
            if system == 'Darwin':
                cmd = ["umount"]
                if force:
                    cmd.append("-f")
                cmd.append(mount_point)
            else:
                cmd = ["sudo", "umount"]
                if force:
                    cmd.append("-f")
                cmd.append(mount_point)
            
            logger.info(f"Unmounting {mount_point}")
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=15
            )
            
            if result.returncode == 0:
                logger.info(f"Successfully unmounted {mount_point}")
                return True, f"✅ Unmounted {mount_point}"
            else:
                error_msg = result.stderr.strip() or result.stdout.strip()
                logger.error(f"Unmount failed: {error_msg}")
                
                if "busy" in error_msg.lower() or "in use" in error_msg.lower():
                    return False, f"❌ Device is busy. Close any programs using {mount_point}"
                else:
                    return False, f"❌ Unmount failed: {error_msg}"
        
        except subprocess.TimeoutExpired:
            return False, "❌ Unmount timeout"
        except Exception as e:
            logger.error(f"Error during unmount: {e}")
            return False, f"❌ Error: {str(e)}"
    
    @staticmethod
    def list_mounts() -> List[Dict[str, str]]:
        """
        List current network mounts.
        
        Returns:
            List of dicts with mount information
        """
        mounts = []
        
        try:
            result = subprocess.run(
                ["mount"],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            for line in result.stdout.splitlines():
                # Look for CIFS/SMB mounts
                if 'cifs' in line.lower() or 'smbfs' in line.lower():
                    # Parse mount line (format varies by OS)
                    parts = line.split()
                    if len(parts) >= 3:
                        mounts.append({
                            'source': parts[0],
                            'mount_point': parts[2] if len(parts) > 2 else 'unknown',
                            'type': 'smb/cifs',
                            'raw': line
                        })
            
            return mounts
        
        except Exception as e:
            logger.error(f"Error listing mounts: {e}")
            return []
    
    @staticmethod
    def test_mount_point(mount_point: str) -> Tuple[bool, str]:
        """
        Test if a mount point is accessible.
        
        Returns:
            (is_accessible, message)
        """
        try:
            path = Path(mount_point)
            
            if not path.exists():
                return False, "Mount point does not exist"
            
            if not path.is_dir():
                return False, "Mount point is not a directory"
            
            # Try to list contents
            list(path.iterdir())
            
            return True, "Mount point is accessible"
        
        except PermissionError:
            return False, "Permission denied"
        except Exception as e:
            return False, f"Error: {str(e)}"