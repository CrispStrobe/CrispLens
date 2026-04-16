# folder_training.py - Train from folder structure with comprehensive validation
from pathlib import Path
import re
import logging
from collections import defaultdict

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class FolderTrainer:
    """Train from folder structure: PersonName/images.jpg with robust validation."""

    # Constants
    DEFAULT_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.pgm', '.ppm', '.tiff', '.tif'}
    MIN_IMAGES_PER_PERSON = 1  # Minimum for warning
    RECOMMENDED_IMAGES_PER_PERSON = 3
    MAX_IMAGES_PER_PERSON = 100  # Sanity check
    MAX_PEOPLE = 10000  # Sanity check

    @staticmethod
    def _is_valid_image_file(file_path: Path, allowed_extensions: set) -> bool:
        """Check if file is a valid image."""
        if not file_path.is_file():
            return False

        # Check extension
        if file_path.suffix.lower() not in allowed_extensions:
            return False

        # Check if hidden file
        if file_path.name.startswith('.'):
            return False

        # Check file size (skip empty files)
        try:
            if file_path.stat().st_size == 0:
                logger.warning(f"Skipping empty file: {file_path}")
                return False
        except OSError as e:
            logger.warning(f"Cannot access file {file_path}: {e}")
            return False

        return True

    @staticmethod
    def _clean_person_name(raw_name: str) -> str:
        """Clean and normalize person name."""
        # Remove leading/trailing whitespace
        name = raw_name.strip()

        # Handle AT&T dataset style (s1, s2, etc.)
        if re.match(r'^s\d+$', name.lower()):
            return f"Person {name.upper()}"

        # Handle numeric-only names
        if name.isdigit():
            return f"Person {name}"

        # Replace underscores and multiple spaces
        name = re.sub(r'[_]+', ' ', name)
        name = re.sub(r'\s+', ' ', name)

        # Capitalize properly
        name = ' '.join(word.capitalize() for word in name.split())

        return name

    @staticmethod
    def scan_training_folder(base_path: str,
                            file_extensions: list[str] | None = None) -> dict[str, list[str]]:
        """
        Scan folder structure and extract person -> images mapping.
        
        Folder structure:
        base_path/
            John Smith/
                photo1.jpg
                photo2.jpg
            Jane Doe/
                img1.png
                img2.png
        
        Or AT&T style:
        base_path/
            s1/
                1.pgm
                2.pgm
            s2/
                1.pgm
        
        Args:
            base_path: Root folder path
            file_extensions: List of allowed extensions (with dot, e.g., ['.jpg', '.png'])
        
        Returns:
            {person_name: [image_paths]}
        
        Raises:
            ValueError: If folder not found or invalid
        """
        # Validate base path
        base = Path(base_path)
        if not base.exists():
            raise ValueError(f"Folder not found: {base_path}")

        if not base.is_dir():
            raise ValueError(f"Path is not a directory: {base_path}")

        # Prepare extensions
        if file_extensions is None:
            allowed_extensions = FolderTrainer.DEFAULT_EXTENSIONS
        else:
            # Normalize extensions (ensure lowercase with dot)
            allowed_extensions = set()
            for ext in file_extensions:
                ext = ext.strip().lower()
                if not ext.startswith('.'):
                    ext = '.' + ext
                allowed_extensions.add(ext)

        logger.info(f"Scanning folder: {base_path}")
        logger.info(f"Allowed extensions: {allowed_extensions}")

        person_to_images = {}
        skipped_folders = []

        # Look for subdirectories
        try:
            subdirs = [d for d in base.iterdir() if d.is_dir()]
        except PermissionError:
            raise ValueError(f"Permission denied accessing folder: {base_path}")  # noqa: B904

        if not subdirs:
            raise ValueError(f"No subdirectories found in {base_path}. Expected structure: PersonName/images.jpg")

        for person_dir in subdirs:
            # Skip hidden folders
            if person_dir.name.startswith('.'):
                logger.debug(f"Skipping hidden folder: {person_dir.name}")
                continue

            # Skip common non-person folders
            skip_names = {'__pycache__', 'thumbnails', 'cache', '.git', '.svn', 'temp', 'tmp'}
            if person_dir.name.lower() in skip_names:
                logger.debug(f"Skipping system folder: {person_dir.name}")
                continue

            # Person name from folder name
            person_name = FolderTrainer._clean_person_name(person_dir.name)

            # Find images in this folder
            images = []
            try:
                for img_file in person_dir.iterdir():
                    if FolderTrainer._is_valid_image_file(img_file, allowed_extensions):
                        images.append(str(img_file.resolve()))
            except PermissionError as e:
                logger.warning(f"Permission denied accessing folder {person_dir}: {e}")
                skipped_folders.append(person_dir.name)
                continue

            # Add to results if images found
            if images:
                # Check for duplicate person names (case-insensitive)
                existing_key = None
                for key in person_to_images:
                    if key.lower() == person_name.lower():
                        existing_key = key
                        break

                if existing_key:
                    # Merge images
                    person_to_images[existing_key].extend(images)
                    logger.warning(f"Merged duplicate person: {person_dir.name} -> {existing_key}")
                else:
                    person_to_images[person_name] = images

                logger.info(f"Found {len(images)} images for: {person_name}")
            else:
                skipped_folders.append(person_dir.name)
                logger.warning(f"No valid images found in folder: {person_dir.name}")

        # Validation
        if not person_to_images:
            msg = "No valid person folders with images found."
            if skipped_folders:
                msg += f" Skipped folders: {', '.join(skipped_folders)}"
            raise ValueError(msg)

        # Sanity check
        if len(person_to_images) > FolderTrainer.MAX_PEOPLE:
            logger.warning(f"Found {len(person_to_images)} people, which seems unusually high")

        logger.info(f"Successfully scanned {len(person_to_images)} people with "
                   f"{sum(len(imgs) for imgs in person_to_images.values())} total images")

        return person_to_images

    @staticmethod
    def validate_folder_structure(base_path: str,
                                  file_extensions: list[str] | None = None) -> tuple[bool, str, dict]:
        """
        Validate folder structure and return detailed summary.
        
        Returns:
            (is_valid, message, summary_dict)
        """
        try:
            person_to_images = FolderTrainer.scan_training_folder(base_path, file_extensions)

            if not person_to_images:
                return False, "No valid person folders found", {}

            # Calculate statistics
            total_people = len(person_to_images)
            total_images = sum(len(imgs) for imgs in person_to_images.values())
            avg_images = total_images / total_people

            # Analyze each person
            warnings = []
            errors = []
            people_details = []

            for person, images in sorted(person_to_images.items()):
                num_images = len(images)

                detail = {
                    'name': person,
                    'num_images': num_images,
                    'image_paths': images
                }
                people_details.append(detail)

                # Check thresholds
                if num_images < FolderTrainer.MIN_IMAGES_PER_PERSON:
                    errors.append(f"❌ {person}: only {num_images} image(s) - need at least {FolderTrainer.MIN_IMAGES_PER_PERSON}")
                elif num_images < FolderTrainer.RECOMMENDED_IMAGES_PER_PERSON:
                    warnings.append(f"⚠️  {person}: only {num_images} images (recommended: {FolderTrainer.RECOMMENDED_IMAGES_PER_PERSON}+)")
                elif num_images > FolderTrainer.MAX_IMAGES_PER_PERSON:
                    warnings.append(f"⚠️  {person}: {num_images} images is unusually high")

            # Build summary
            summary = {
                'total_people': total_people,
                'total_images': total_images,
                'avg_images_per_person': round(avg_images, 2),
                'people': [p['name'] for p in people_details],
                'people_details': people_details,
                'warnings': warnings,
                'errors': errors
            }

            # Build message
            message_parts = [f"✅ Found {total_people} people with {total_images} total images"]
            message_parts.append(f"   Average: {avg_images:.1f} images per person")

            if errors:
                message_parts.append("\n❌ Errors:")
                message_parts.extend(errors)

            if warnings:
                message_parts.append("\n⚠️  Warnings:")
                message_parts.extend(warnings)

            message = "\n".join(message_parts)

            # Valid if no errors
            is_valid = len(errors) == 0

            return is_valid, message, summary

        except ValueError as e:
            return False, f"❌ {str(e)}", {}

        except Exception as e:
            logger.error(f"Unexpected error validating folder: {e}", exc_info=True)
            return False, f"❌ Unexpected error: {str(e)}", {}

    @staticmethod
    def get_folder_stats(base_path: str, file_extensions: list[str] | None = None) -> dict:
        """
        Get detailed statistics about a training folder.
        
        Returns:
            Dict with comprehensive statistics
        """
        try:
            person_to_images = FolderTrainer.scan_training_folder(base_path, file_extensions)

            # Calculate statistics
            image_counts = [len(imgs) for imgs in person_to_images.values()]

            stats = {
                'total_people': len(person_to_images),
                'total_images': sum(image_counts),
                'min_images': min(image_counts) if image_counts else 0,
                'max_images': max(image_counts) if image_counts else 0,
                'avg_images': sum(image_counts) / len(image_counts) if image_counts else 0,
                'median_images': sorted(image_counts)[len(image_counts) // 2] if image_counts else 0,
                'people_with_few_images': sum(1 for c in image_counts if c < FolderTrainer.RECOMMENDED_IMAGES_PER_PERSON),
                'people_with_many_images': sum(1 for c in image_counts if c >= FolderTrainer.RECOMMENDED_IMAGES_PER_PERSON),
                'distribution': dict(sorted(
                    defaultdict(int, {f"{person}": len(imgs) for person, imgs in person_to_images.items()}).items(),
                    key=lambda x: x[1],
                    reverse=True
                ))
            }

            return stats

        except Exception as e:
            logger.error(f"Error getting folder stats: {e}")
            return {}

    @staticmethod
    def preview_folder(base_path: str, max_people: int = 10) -> str:
        """
        Generate a preview text of the folder structure.
        
        Args:
            base_path: Root folder
            max_people: Maximum people to show in preview
        
        Returns:
            Preview text
        """
        try:
            person_to_images = FolderTrainer.scan_training_folder(base_path)

            lines = [
                f"📁 Training Folder: {base_path}",
                f"   Total People: {len(person_to_images)}",
                f"   Total Images: {sum(len(imgs) for imgs in person_to_images.values())}",
                "",
                "📋 Preview:"
            ]

            for i, (person, images) in enumerate(sorted(person_to_images.items()), 1):
                if i > max_people:
                    remaining = len(person_to_images) - max_people
                    lines.append(f"   ... and {remaining} more people")
                    break

                lines.append(f"   {i}. {person}: {len(images)} images")

            return "\n".join(lines)

        except Exception as e:
            return f"❌ Error previewing folder: {str(e)}"
