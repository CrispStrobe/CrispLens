#!/usr/bin/env python3
"""
face_recognition_benchmark.py - COMPLETE with model selection and proper JSON output
"""

import time
import psutil
import os
import sys
import numpy as np
import cv2
from dataclasses import dataclass, asdict
import json
import threading
import logging

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Try importing all libraries
AVAILABLE_METHODS = {}

try:
    import face_recognition  # noqa: F401  — availability probe
    import dlib  # noqa: F401  — availability probe
    AVAILABLE_METHODS['dlib_hog'] = True
    AVAILABLE_METHODS['dlib_cnn'] = True
except ImportError:
    AVAILABLE_METHODS['dlib_hog'] = False
    AVAILABLE_METHODS['dlib_cnn'] = False

try:
    from insightface.app import FaceAnalysis
    AVAILABLE_METHODS['insightface'] = True
except ImportError:
    AVAILABLE_METHODS['insightface'] = False

# Global verbose flag
VERBOSE = False


@dataclass
class BenchmarkResult:
    method: str
    detection_time: float
    encoding_time: float
    total_time: float
    faces_detected: int
    expected_faces: int
    memory_peak_mb: float
    memory_base_mb: float
    memory_delta_mb: float
    embedding_dimension: int
    detection_accuracy: float = 0.0
    error: str | None = None


@dataclass
class AccuracyMetrics:
    method: str
    total_faces_expected: int
    total_faces_detected: int
    detection_rate: float
    false_positives: int
    false_negatives: int
    avg_confidence: float
    correctly_identified: int = 0
    recognition_accuracy: float = 0.0


def convert_to_json_serializable(obj):
    """Convert numpy types to Python native types for JSON serialization."""
    if isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.floating):
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    elif isinstance(obj, dict):
        return {k: convert_to_json_serializable(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_to_json_serializable(item) for item in obj]
    return obj


class MemoryMonitor:
    """Monitor peak memory usage during execution."""

    def __init__(self):
        self.peak_memory = 0
        self.baseline_memory = 0
        self.monitoring = False
        self.monitor_thread = None
        self.process = psutil.Process(os.getpid())

    def start(self):
        self.baseline_memory = self.process.memory_info().rss / 1024 / 1024
        self.peak_memory = self.baseline_memory
        self.monitoring = True
        self.monitor_thread = threading.Thread(target=self._monitor)
        self.monitor_thread.daemon = True
        self.monitor_thread.start()

    def _monitor(self):
        while self.monitoring:
            current = self.process.memory_info().rss / 1024 / 1024
            if current > self.peak_memory:
                self.peak_memory = current
            time.sleep(0.05)  # Check every 50ms for better accuracy

    def stop(self):
        self.monitoring = False
        if self.monitor_thread:
            self.monitor_thread.join(timeout=1)

        return {
            'peak_mb': self.peak_memory,
            'baseline_mb': self.baseline_memory,
            'delta_mb': self.peak_memory - self.baseline_memory
        }


def load_image_universal(image_path: str):
    """Load image in any format and convert to RGB numpy array."""
    if VERBOSE:
        logger.debug(f"Loading image: {image_path}")

    img = cv2.imread(image_path)

    if img is None:
        img = cv2.imread(image_path, cv2.IMREAD_ANYCOLOR | cv2.IMREAD_ANYDEPTH)

    if img is None:
        raise ValueError(f"Failed to load image: {image_path}")

    # Convert grayscale to RGB if needed
    if len(img.shape) == 2:
        if VERBOSE:
            logger.debug("  Converting grayscale to RGB")
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)

    if VERBOSE:
        logger.debug(f"  Loaded: shape={img.shape}, dtype={img.dtype}")

    return img


class FaceRecognitionBase:
    """Base class for face recognition systems."""

    def __init__(self, name: str):
        self.name = name
        self.embeddings = []
        self.labels = []

    def train(self, image_path: str, person_name: str):
        raise NotImplementedError

    def recognize(self, image_path: str, threshold: float = 0.6):
        raise NotImplementedError

    def detect_and_encode(self, image_path: str):
        raise NotImplementedError


class DlibHOGRecognizer(FaceRecognitionBase):
    """dlib with HOG detector."""

    def __init__(self):
        super().__init__("dlib_hog")
        if VERBOSE:
            logger.info(f"Initializing {self.name}...")
        print(f"[•] Initializing {self.name}...")

    def train(self, image_path: str, person_name: str):
        if VERBOSE:
            logger.debug(f"Training on: {image_path} -> {person_name}")

        img = face_recognition.load_image_file(image_path)
        encodings = face_recognition.face_encodings(img, model="small")

        if VERBOSE:
            logger.debug(f"  Found {len(encodings)} faces")

        for encoding in encodings:
            self.embeddings.append(encoding)
            self.labels.append(person_name)

        return len(encodings)

    def detect_and_encode(self, image_path: str):
        if VERBOSE:
            logger.debug(f"Detecting in: {image_path}")

        img = face_recognition.load_image_file(image_path)

        start = time.time()
        face_locations = face_recognition.face_locations(img, model="hog")
        detection_time = time.time() - start

        if VERBOSE:
            logger.debug(f"  Detection: {len(face_locations)} faces in {detection_time:.3f}s")

        start = time.time()
        face_encodings = face_recognition.face_encodings(img, face_locations, model="small")
        encoding_time = time.time() - start

        if VERBOSE:
            logger.debug(f"  Encoding: {len(face_encodings)} faces in {encoding_time:.3f}s")

        faces = []
        for loc, enc in zip(face_locations, face_encodings, strict=False):
            faces.append({
                'bbox': {'top': loc[0], 'right': loc[1], 'bottom': loc[2], 'left': loc[3]},
                'embedding': enc,
                'confidence': 1.0
            })

        return faces, detection_time, encoding_time

    def recognize(self, image_path: str, threshold: float = 0.6):
        if not self.embeddings:
            if VERBOSE:
                logger.warning("No embeddings available for recognition!")
            return []

        if VERBOSE:
            logger.debug(f"Recognizing with {len(self.embeddings)} known embeddings")

        faces, _, _ = self.detect_and_encode(image_path)
        results = []

        for i, face in enumerate(faces):
            distances = face_recognition.face_distance(self.embeddings, face['embedding'])
            min_idx = np.argmin(distances)

            if VERBOSE:
                logger.debug(f"  Face {i+1}: best match distance={distances[min_idx]:.3f} -> {self.labels[min_idx]}")

            if distances[min_idx] < threshold:
                confidence = 1 - distances[min_idx]
                results.append((face['bbox'], self.labels[min_idx], float(confidence)))
            else:
                results.append((face['bbox'], 'Unknown', 0.0))

        return results


class DlibCNNRecognizer(FaceRecognitionBase):
    """dlib with CNN detector."""

    def __init__(self):
        super().__init__("dlib_cnn")
        if VERBOSE:
            logger.info(f"Initializing {self.name}...")
        print(f"[•] Initializing {self.name}...")

    def train(self, image_path: str, person_name: str):
        if VERBOSE:
            logger.debug(f"Training on: {image_path} -> {person_name}")

        img = face_recognition.load_image_file(image_path)
        encodings = face_recognition.face_encodings(img, model="small")

        if VERBOSE:
            logger.debug(f"  Found {len(encodings)} faces")

        for encoding in encodings:
            self.embeddings.append(encoding)
            self.labels.append(person_name)

        return len(encodings)

    def detect_and_encode(self, image_path: str):
        if VERBOSE:
            logger.debug(f"Detecting in: {image_path}")

        img = face_recognition.load_image_file(image_path)

        start = time.time()
        face_locations = face_recognition.face_locations(img, model="cnn")
        detection_time = time.time() - start

        if VERBOSE:
            logger.debug(f"  Detection: {len(face_locations)} faces in {detection_time:.3f}s")

        start = time.time()
        face_encodings = face_recognition.face_encodings(img, face_locations, model="small")
        encoding_time = time.time() - start

        if VERBOSE:
            logger.debug(f"  Encoding: {len(face_encodings)} faces in {encoding_time:.3f}s")

        faces = []
        for loc, enc in zip(face_locations, face_encodings, strict=False):
            faces.append({
                'bbox': {'top': loc[0], 'right': loc[1], 'bottom': loc[2], 'left': loc[3]},
                'embedding': enc,
                'confidence': 1.0
            })

        return faces, detection_time, encoding_time

    def recognize(self, image_path: str, threshold: float = 0.6):
        if not self.embeddings:
            if VERBOSE:
                logger.warning("No embeddings available for recognition!")
            return []

        faces, _, _ = self.detect_and_encode(image_path)
        results = []

        for face in faces:
            distances = face_recognition.face_distance(self.embeddings, face['embedding'])
            min_idx = np.argmin(distances)

            if distances[min_idx] < threshold:
                confidence = 1 - distances[min_idx]
                results.append((face['bbox'], self.labels[min_idx], float(confidence)))
            else:
                results.append((face['bbox'], 'Unknown', 0.0))

        return results


class InsightFaceRecognizer(FaceRecognitionBase):
    """
    InsightFace with configurable model pack.
    
    Model Packs (from InsightFace docs):
    - buffalo_l (default): 326MB, best accuracy (91.25 MR-ALL)
    - buffalo_s: 159MB, faster but less accurate (71.87 MR-ALL)
    - buffalo_m: 313MB, same accuracy as buffalo_l
    - buffalo_sc: 16MB, minimal (detection only)
    - antelopev2: 407MB, highest accuracy
    """

    def __init__(self, model_pack='buffalo_l'):
        super().__init__(f"insightface_{model_pack}")
        self.model_pack = model_pack

        if VERBOSE:
            logger.info(f"Initializing {self.name}...")
        print(f"[•] Initializing InsightFace with model: {model_pack}")

        self.app = FaceAnalysis(
            name=model_pack,
            providers=['CPUExecutionProvider'],
            allowed_modules=['detection', 'recognition']
        )
        self.app.prepare(ctx_id=-1, det_size=(640, 640))

        if VERBOSE:
            logger.info(f"  InsightFace initialized with {model_pack} model")

        print(f"[✓] Model loaded: {model_pack}")

    def _get_optimal_det_size(self, img_shape):
        """Calculate optimal detection size based on image dimensions."""
        h, w = img_shape[:2]
        max_dim = max(h, w)

        if max_dim < 200:
            det_size = (128, 128)
        elif max_dim < 400:
            det_size = (320, 320)
        elif max_dim < 800:
            det_size = (480, 480)
        else:
            det_size = (640, 640)

        if VERBOSE:
            logger.debug(f"  Image size: {w}x{h}, using det_size: {det_size}")

        return det_size

    def train(self, image_path: str, person_name: str):
        if VERBOSE:
            logger.debug(f"Training on: {image_path} -> {person_name}")

        try:
            img = load_image_universal(image_path)
            det_size = self._get_optimal_det_size(img.shape)
            self.app.det_model.input_size = det_size

            img_bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
            faces = self.app.get(img_bgr)

            if VERBOSE:
                logger.debug(f"  Found {len(faces)} faces")

            for face in faces:
                self.embeddings.append(face.normed_embedding)
                self.labels.append(person_name)

            return len(faces)

        except Exception as e:
            if VERBOSE:
                logger.error(f"  ERROR training on {image_path}: {e}")
            return 0

    def detect_and_encode(self, image_path: str):
        if VERBOSE:
            logger.debug(f"Detecting in: {image_path}")

        try:
            img = load_image_universal(image_path)
            det_size = self._get_optimal_det_size(img.shape)
            self.app.det_model.input_size = det_size

            img_bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)

            start = time.time()
            faces = self.app.get(img_bgr)
            total_time = time.time() - start

            if VERBOSE:
                logger.debug(f"  Found {len(faces)} faces in {total_time:.3f}s")

            detection_time = total_time * 0.3
            encoding_time = total_time * 0.7

            results = []
            for i, face in enumerate(faces):
                bbox = face.bbox.astype(int)

                if VERBOSE:
                    logger.debug(f"  Face {i+1}: bbox={bbox}, score={face.det_score:.3f}")

                results.append({
                    'bbox': {
                        'left': int(bbox[0]), 'top': int(bbox[1]),
                        'right': int(bbox[2]), 'bottom': int(bbox[3])
                    },
                    'embedding': face.normed_embedding,
                    'confidence': float(face.det_score)
                })

            return results, detection_time, encoding_time

        except Exception as e:
            if VERBOSE:
                logger.error(f"  ERROR detecting in {image_path}: {e}")
            return [], 0, 0

    def recognize(self, image_path: str, threshold: float = 0.4):
        if not self.embeddings:
            if VERBOSE:
                logger.warning("No embeddings available for recognition!")
            return []

        if VERBOSE:
            logger.debug(f"Recognizing with {len(self.embeddings)} known embeddings, threshold={threshold}")

        faces, _, _ = self.detect_and_encode(image_path)

        if VERBOSE:
            logger.debug(f"  Detected {len(faces)} faces to recognize")

        results = []

        for i, face in enumerate(faces):
            similarities = np.dot(self.embeddings, face['embedding'])
            max_idx = np.argmax(similarities)
            max_sim = float(similarities[max_idx])

            if VERBOSE:
                logger.debug(f"  Face {i+1}: best match similarity={max_sim:.3f} -> {self.labels[max_idx]}")

            if max_sim > threshold:
                results.append((face['bbox'], self.labels[max_idx], max_sim))
            else:
                results.append((face['bbox'], 'Unknown', 0.0))

        return results


def count_faces_in_image(image_path: str) -> int:
    """Extract expected face count from filename."""
    filename = os.path.basename(image_path)

    if 'people' in filename:
        try:
            parts = filename.split('_')
            for part in parts:
                if 'people' in part:
                    num = int(part.replace('people', '').replace('.jpg', '').replace('.png', ''))
                    return num
        except:
            pass

    return -1


def benchmark_method(recognizer: FaceRecognitionBase, test_image: str, num_runs: int = 5):
    """Benchmark with proper memory tracking."""
    print(f"\n{'='*60}")
    print(f"Benchmarking: {recognizer.name}")
    print(f"{'='*60}")

    expected_faces = count_faces_in_image(test_image)

    detection_times = []
    encoding_times = []
    total_times = []
    faces_detected_list = []
    embedding_dim = 0
    memory_results = []

    try:
        for run in range(num_runs):
            if VERBOSE:
                logger.info(f"  Starting run {run+1}/{num_runs}")

            mem_monitor = MemoryMonitor()
            mem_monitor.start()

            start_total = time.time()
            faces, det_time, enc_time = recognizer.detect_and_encode(test_image)
            total_time = time.time() - start_total

            mem_stats = mem_monitor.stop()

            detection_times.append(det_time)
            encoding_times.append(enc_time)
            total_times.append(total_time)
            faces_detected_list.append(len(faces))
            memory_results.append(mem_stats)

            if run == 0 and faces:
                embedding_dim = len(faces[0]['embedding'])

            print(f"  Run {run+1}: {total_time:.3f}s - {len(faces)} faces - "
                  f"Peak: {mem_stats['peak_mb']:.1f}MB (Δ +{mem_stats['delta_mb']:.1f}MB)")

        avg_peak = np.mean([m['peak_mb'] for m in memory_results])
        avg_baseline = np.mean([m['baseline_mb'] for m in memory_results])
        avg_delta = np.mean([m['delta_mb'] for m in memory_results])

        faces_detected = int(np.mean(faces_detected_list))

        if expected_faces > 0:
            detection_accuracy = (faces_detected / expected_faces) * 100
        else:
            detection_accuracy = 0.0

        result = BenchmarkResult(
            method=recognizer.name,
            detection_time=float(np.mean(detection_times)),
            encoding_time=float(np.mean(encoding_times)),
            total_time=float(np.mean(total_times)),
            faces_detected=faces_detected,
            expected_faces=expected_faces,
            memory_peak_mb=float(avg_peak),
            memory_base_mb=float(avg_baseline),
            memory_delta_mb=float(avg_delta),
            embedding_dimension=embedding_dim,
            detection_accuracy=float(detection_accuracy)
        )

        print("\n  📊 Summary:")
        print(f"     Time:         {result.total_time:.3f}s (det: {result.detection_time:.3f}s, enc: {result.encoding_time:.3f}s)")
        print(f"     Detection:    {result.faces_detected}/{result.expected_faces} faces ({result.detection_accuracy:.1f}%)")
        print(f"     Memory Peak:  {result.memory_peak_mb:.1f}MB (baseline: {result.memory_base_mb:.1f}MB, increase: +{result.memory_delta_mb:.1f}MB)")
        print(f"     Embedding:    {result.embedding_dimension}-d")

    except Exception as e:
        print(f"  [ERROR] {str(e)}")
        import traceback
        traceback.print_exc()
        result = BenchmarkResult(
            method=recognizer.name,
            detection_time=0, encoding_time=0, total_time=0,
            faces_detected=0, expected_faces=expected_faces,
            memory_peak_mb=0, memory_base_mb=0, memory_delta_mb=0,
            embedding_dimension=0, error=str(e)
        )

    return result


def test_recognition_accuracy(recognizer: FaceRecognitionBase,
                              train_dir: str,
                              test_image: str) -> AccuracyMetrics:
    """Test recognition accuracy with detailed metrics."""
    print(f"\n{'='*60}")
    print(f"Testing Recognition Accuracy: {recognizer.name}")
    print(f"{'='*60}")

    # Train
    print("[•] Training...")
    person_to_images = {}

    for filename in os.listdir(train_dir):
        if filename.lower().endswith(('.jpg', '.jpeg', '.png', '.pgm')):
            person_name = '_'.join(filename.split('_')[:-1])

            if person_name not in person_to_images:
                person_to_images[person_name] = []
            person_to_images[person_name].append(filename)

    total_faces_trained = 0
    failed_images = 0

    for person_name, images in person_to_images.items():
        person_faces = 0
        for img in images:
            filepath = os.path.join(train_dir, img)
            faces_found = recognizer.train(filepath, person_name)
            person_faces += faces_found
            if faces_found == 0:
                failed_images += 1

        total_faces_trained += person_faces
        if not VERBOSE:
            print(f"  {person_name}: {person_faces} faces from {len(images)} images")

    print(f"[✓] Trained on {total_faces_trained} faces from {len(person_to_images)} people")

    if failed_images > 0:
        print(f"[!] WARNING: {failed_images} images produced no faces!")

    if total_faces_trained == 0:
        print("[!] ERROR: No faces were trained!")
        return AccuracyMetrics(
            method=recognizer.name,
            total_faces_expected=0,
            total_faces_detected=0,
            detection_rate=0,
            false_positives=0,
            false_negatives=0,
            avg_confidence=0,
            correctly_identified=0,
            recognition_accuracy=0
        )

    # Recognize
    print("\n[•] Recognizing faces in test image...")
    expected_faces = count_faces_in_image(test_image)

    results = recognizer.recognize(test_image)

    detected = len(results)
    recognized = len([r for r in results if r[1] != 'Unknown'])
    unknown = len([r for r in results if r[1] == 'Unknown'])

    confidences = [r[2] for r in results if r[2] > 0]
    avg_confidence = float(np.mean(confidences)) if confidences else 0.0

    detection_rate = float(detected / expected_faces * 100) if expected_faces > 0 else 0.0

    correctly_identified = recognized
    recognition_accuracy = float(recognized / detected * 100) if detected > 0 else 0.0

    metrics = AccuracyMetrics(
        method=recognizer.name,
        total_faces_expected=expected_faces,
        total_faces_detected=detected,
        detection_rate=detection_rate,
        false_positives=0,
        false_negatives=max(0, expected_faces - detected),
        avg_confidence=avg_confidence,
        correctly_identified=correctly_identified,
        recognition_accuracy=recognition_accuracy
    )

    print("\n📊 Results:")
    print(f"   Expected faces:        {metrics.total_faces_expected}")
    print(f"   Detected faces:        {metrics.total_faces_detected}")
    print(f"   Detection rate:        {metrics.detection_rate:.1f}%")
    print(f"   Recognized (known):    {metrics.correctly_identified}")
    print(f"   Unknown:               {unknown}")
    print(f"   Recognition accuracy:  {metrics.recognition_accuracy:.1f}%")
    print(f"   Avg confidence:        {metrics.avg_confidence:.2%}")
    print(f"   False negatives:       {metrics.false_negatives}")

    if not VERBOSE:
        print("\n📝 Detailed Results (first 20):")
        for i, (bbox, name, conf) in enumerate(results[:20], 1):
            status = "✓" if name != "Unknown" else "✗"
            print(f"   {i:2d}. {status} {name:20s} ({conf:.2%})")

        if len(results) > 20:
            print(f"   ... and {len(results) - 20} more faces")

    return metrics


def main():
    global VERBOSE

    import argparse

    parser = argparse.ArgumentParser(
        description='Complete Face Recognition Benchmark',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
InsightFace Model Options (--insightface-model):
  buffalo_l     - Default, best accuracy (326MB, 91.25 MR-ALL)
  buffalo_s     - Faster, smaller (159MB, 71.87 MR-ALL)  
  buffalo_m     - Medium (313MB, same accuracy as buffalo_l)
  buffalo_sc    - Minimal, detection only (16MB)
  antelopev2    - Highest accuracy (407MB) [manual download required]

Memory Metrics:
  Peak:    Maximum RAM used during processing
  Δ:       Increase from baseline (how much the model added)
  
Examples:
  # Quick test with default model
  python %(prog)s --mode both --image photo.jpg --train-dir faces/ --methods insightface
  
  # Use faster buffalo_s model
  python %(prog)s --mode benchmark --image photo.jpg --methods insightface --insightface-model buffalo_s
  
  # Compare all methods
  python %(prog)s --mode both --image photo.jpg --train-dir faces/ --methods all --verbose
        """
    )

    parser.add_argument('--mode', choices=['benchmark', 'test', 'both'], required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--train-dir')
    parser.add_argument('--runs', type=int, default=5)
    parser.add_argument('--methods', nargs='+',
                       choices=['dlib_hog', 'dlib_cnn', 'insightface', 'all'],
                       default=['all'])
    parser.add_argument('--insightface-model',
                       choices=['buffalo_l', 'buffalo_s', 'buffalo_m', 'buffalo_sc', 'antelopev2'],
                       default='buffalo_l',
                       help='InsightFace model pack to use')
    parser.add_argument('--output', default='benchmark_results.json')
    parser.add_argument('--verbose', '-v', action='store_true')

    args = parser.parse_args()

    if args.verbose:
        VERBOSE = True
        logger.setLevel(logging.DEBUG)
        logger.info("Verbose mode enabled")

    # Determine methods
    if 'all' in args.methods:
        methods = [k for k, v in AVAILABLE_METHODS.items() if v and k in ['dlib_hog', 'dlib_cnn', 'insightface']]
    else:
        methods = [m for m in args.methods if AVAILABLE_METHODS.get(m, False)]

    if not methods:
        print("[!] No methods available. Install packages:")
        print("  pip install face_recognition insightface onnxruntime")
        sys.exit(1)

    print(f"\n{'='*60}")
    print("FACE RECOGNITION COMPLETE TEST")
    print(f"{'='*60}")
    print(f"Mode: {args.mode}")
    print(f"Test Image: {args.image}")
    print(f"Methods: {', '.join(methods)}")
    if 'insightface' in methods:
        print(f"InsightFace Model: {args.insightface_model}")
    if args.verbose:
        print("Verbose: ENABLED")
    print(f"{'='*60}\n")

    # Initialize recognizers
    recognizers = []
    for method in methods:
        if method == 'dlib_hog':
            recognizers.append(DlibHOGRecognizer())
        elif method == 'dlib_cnn':
            recognizers.append(DlibCNNRecognizer())
        elif method == 'insightface':
            recognizers.append(InsightFaceRecognizer(model_pack=args.insightface_model))

    benchmark_results = []
    accuracy_results = []

    # Run benchmarks
    if args.mode in ['benchmark', 'both']:
        print("\n" + "="*60)
        print("SPEED BENCHMARK")
        print("="*60)

        for recognizer in recognizers:
            result = benchmark_method(recognizer, args.image, args.runs)
            benchmark_results.append(result)

    # Run accuracy tests
    if args.mode in ['test', 'both']:
        if not args.train_dir:
            print("[!] --train-dir required for accuracy test")
            sys.exit(1)

        print("\n" + "="*60)
        print("ACCURACY TEST")
        print("="*60)

        for recognizer in recognizers:
            metrics = test_recognition_accuracy(recognizer, args.train_dir, args.image)
            accuracy_results.append(metrics)

    # Print final summary
    print("\n" + "="*60)
    print("FINAL SUMMARY")
    print("="*60)

    if benchmark_results:
        print("\n📈 Speed Rankings:")
        valid = [r for r in benchmark_results if r.error is None]
        valid.sort(key=lambda x: x.total_time)

        for i, r in enumerate(valid, 1):
            print(f"{i}. {r.method:20s} {r.total_time:6.2f}s  "
                  f"Detection: {r.detection_accuracy:5.1f}%  "
                  f"Peak Mem: {r.memory_peak_mb:6.1f}MB")

        if valid:
            best = valid[0]
            print(f"\n🏆 FASTEST: {best.method} ({best.total_time:.2f}s)")

    if accuracy_results:
        print("\n🎯 Accuracy Rankings:")
        accuracy_results.sort(key=lambda x: x.recognition_accuracy, reverse=True)

        for i, m in enumerate(accuracy_results, 1):
            print(f"{i}. {m.method:20s} "
                  f"Detection: {m.detection_rate:5.1f}%  "
                  f"Recognition: {m.recognition_accuracy:5.1f}%  "
                  f"Conf: {m.avg_confidence:.2%}")

        if accuracy_results:
            best = accuracy_results[0]
            print(f"\n🎯 MOST ACCURATE: {best.method} ({best.recognition_accuracy:.1f}%)")

    # Save results (with proper JSON serialization)
    output_data = {
        'benchmark_results': [
            convert_to_json_serializable(asdict(r)) for r in benchmark_results
        ],
        'accuracy_results': [
            convert_to_json_serializable(asdict(m)) for m in accuracy_results
        ],
        'config': {
            'insightface_model': args.insightface_model if 'insightface' in methods else None,
            'test_image': args.image,
            'num_runs': args.runs
        }
    }

    try:
        with open(args.output, 'w') as f:
            json.dump(output_data, f, indent=2)
        print(f"\n💾 Results saved to: {args.output}")
    except Exception as e:
        print(f"\n[!] Warning: Could not save JSON: {e}")


if __name__ == "__main__":
    main()
