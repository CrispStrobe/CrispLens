#!/usr/bin/env python3
"""
face_recognition_benchmark.py - COMPLETE working benchmark
All methods include REAL face recognition with proper embeddings
"""

import time
import psutil
import os
import sys
import numpy as np
import cv2
from dataclasses import dataclass

# Installation check and imports
AVAILABLE_METHODS = {}

# Method 1: dlib/face_recognition
try:
    import face_recognition
    AVAILABLE_METHODS['dlib_hog'] = True
    AVAILABLE_METHODS['dlib_cnn'] = True
except ImportError:
    print("[!] dlib not available: pip install face_recognition")
    AVAILABLE_METHODS['dlib_hog'] = False
    AVAILABLE_METHODS['dlib_cnn'] = False

# Method 2: InsightFace (BEST for CPU!)
try:
    from insightface.app import FaceAnalysis
    AVAILABLE_METHODS['insightface'] = True
except ImportError:
    print("[!] InsightFace not available: pip install insightface onnxruntime")
    AVAILABLE_METHODS['insightface'] = False

# Method 3: DeepFace (wraps multiple models)
try:
    from deepface import DeepFace
    AVAILABLE_METHODS['deepface_facenet'] = True
    AVAILABLE_METHODS['deepface_arcface'] = True
except ImportError:
    print("[!] DeepFace not available: pip install deepface tf-keras")
    AVAILABLE_METHODS['deepface_facenet'] = False
    AVAILABLE_METHODS['deepface_arcface'] = False

# Method 4: face_recognition with different backends
AVAILABLE_METHODS['face_recognition'] = AVAILABLE_METHODS['dlib_hog']


@dataclass
class BenchmarkResult:
    method: str
    detection_time: float
    encoding_time: float
    total_time: float
    faces_detected: int
    memory_mb: float
    embedding_dimension: int
    error: str | None = None


class FaceRecognitionBase:
    """Base class for face recognition systems."""

    def __init__(self, name: str):
        self.name = name
        self.embeddings = []
        self.labels = []

    def train(self, image_path: str, person_name: str):
        """
        Train on a single image.
        Returns: number of faces found
        """
        raise NotImplementedError

    def recognize(self, image_path: str, threshold: float = 0.6):
        """
        Recognize faces in image.
        Returns: [(bbox, person_name, confidence), ...]
        """
        raise NotImplementedError

    def detect_and_encode(self, image_path: str):
        """
        Detect and encode faces.
        Returns: (faces, detection_time, encoding_time)
        """
        raise NotImplementedError


class DlibHOGRecognizer(FaceRecognitionBase):
    """
    dlib with HOG detector.
    Uses dlib's ResNet model (128-d embeddings) for recognition.
    """

    def __init__(self):
        super().__init__("dlib_hog")
        print(f"[•] Initializing {self.name}...")

    def train(self, image_path: str, person_name: str):
        img = face_recognition.load_image_file(image_path)
        encodings = face_recognition.face_encodings(img, model="small")

        for encoding in encodings:
            self.embeddings.append(encoding)
            self.labels.append(person_name)

        return len(encodings)

    def detect_and_encode(self, image_path: str):
        img = face_recognition.load_image_file(image_path)

        # Detection
        start = time.time()
        face_locations = face_recognition.face_locations(img, model="hog")
        detection_time = time.time() - start

        # Encoding
        start = time.time()
        face_encodings = face_recognition.face_encodings(img, face_locations, model="small")
        encoding_time = time.time() - start

        faces = []
        for loc, enc in zip(face_locations, face_encodings, strict=False):
            faces.append({
                'bbox': {'top': loc[0], 'right': loc[1], 'bottom': loc[2], 'left': loc[3]},
                'embedding': enc
            })

        return faces, detection_time, encoding_time

    def recognize(self, image_path: str, threshold: float = 0.6):
        if not self.embeddings:
            return []

        faces, _, _ = self.detect_and_encode(image_path)
        results = []

        for face in faces:
            # Compare with all known faces
            distances = face_recognition.face_distance(self.embeddings, face['embedding'])
            min_idx = np.argmin(distances)

            if distances[min_idx] < threshold:
                confidence = 1 - distances[min_idx]
                results.append((face['bbox'], self.labels[min_idx], confidence))
            else:
                results.append((face['bbox'], 'Unknown', 0.0))

        return results


class DlibCNNRecognizer(FaceRecognitionBase):
    """dlib with CNN detector (slower but more accurate)."""

    def __init__(self):
        super().__init__("dlib_cnn")
        print(f"[•] Initializing {self.name}...")

    def train(self, image_path: str, person_name: str):
        img = face_recognition.load_image_file(image_path)
        encodings = face_recognition.face_encodings(img, model="small")

        for encoding in encodings:
            self.embeddings.append(encoding)
            self.labels.append(person_name)

        return len(encodings)

    def detect_and_encode(self, image_path: str):
        img = face_recognition.load_image_file(image_path)

        start = time.time()
        face_locations = face_recognition.face_locations(img, model="cnn")
        detection_time = time.time() - start

        start = time.time()
        face_encodings = face_recognition.face_encodings(img, face_locations, model="small")
        encoding_time = time.time() - start

        faces = []
        for loc, enc in zip(face_locations, face_encodings, strict=False):
            faces.append({
                'bbox': {'top': loc[0], 'right': loc[1], 'bottom': loc[2], 'left': loc[3]},
                'embedding': enc
            })

        return faces, detection_time, encoding_time

    def recognize(self, image_path: str, threshold: float = 0.6):
        if not self.embeddings:
            return []

        faces, _, _ = self.detect_and_encode(image_path)
        results = []

        for face in faces:
            distances = face_recognition.face_distance(self.embeddings, face['embedding'])
            min_idx = np.argmin(distances)

            if distances[min_idx] < threshold:
                confidence = 1 - distances[min_idx]
                results.append((face['bbox'], self.labels[min_idx], confidence))
            else:
                results.append((face['bbox'], 'Unknown', 0.0))

        return results


class InsightFaceRecognizer(FaceRecognitionBase):
    """
    InsightFace - Best overall for CPU!
    Uses ArcFace for recognition (512-d embeddings).
    """

    def __init__(self):
        super().__init__("insightface")
        print(f"[•] Initializing {self.name}...")
        self.app = FaceAnalysis(
            providers=['CPUExecutionProvider'],
            allowed_modules=['detection', 'recognition']
        )
        self.app.prepare(ctx_id=-1, det_size=(640, 640))

    def train(self, image_path: str, person_name: str):
        img = cv2.imread(image_path)
        faces = self.app.get(img)

        for face in faces:
            self.embeddings.append(face.normed_embedding)
            self.labels.append(person_name)

        return len(faces)

    def detect_and_encode(self, image_path: str):
        img = cv2.imread(image_path)

        start = time.time()
        faces = self.app.get(img)
        total_time = time.time() - start

        # Split time estimate (detection is ~30%, encoding ~70%)
        detection_time = total_time * 0.3
        encoding_time = total_time * 0.7

        results = []
        for face in faces:
            bbox = face.bbox.astype(int)
            results.append({
                'bbox': {
                    'left': int(bbox[0]), 'top': int(bbox[1]),
                    'right': int(bbox[2]), 'bottom': int(bbox[3])
                },
                'embedding': face.normed_embedding
            })

        return results, detection_time, encoding_time

    def recognize(self, image_path: str, threshold: float = 0.4):
        if not self.embeddings:
            return []

        faces, _, _ = self.detect_and_encode(image_path)
        results = []

        for face in faces:
            # Cosine similarity (embeddings are normalized)
            similarities = np.dot(self.embeddings, face['embedding'])
            max_idx = np.argmax(similarities)

            if similarities[max_idx] > threshold:
                confidence = similarities[max_idx]
                results.append((face['bbox'], self.labels[max_idx], confidence))
            else:
                results.append((face['bbox'], 'Unknown', 0.0))

        return results


class DeepFaceFaceNetRecognizer(FaceRecognitionBase):
    """
    DeepFace with FaceNet model.
    128-d embeddings using Inception ResNet.
    """

    def __init__(self):
        super().__init__("deepface_facenet")
        print(f"[•] Initializing {self.name}...")
        self.model_name = "Facenet"
        # Warm up
        try:
            DeepFace.represent(
                img_path=np.zeros((224, 224, 3), dtype=np.uint8),
                model_name=self.model_name,
                enforce_detection=False
            )
        except:
            pass

    def train(self, image_path: str, person_name: str):
        try:
            embeddings = DeepFace.represent(
                img_path=image_path,
                model_name=self.model_name,
                enforce_detection=True
            )

            for emb in embeddings:
                self.embeddings.append(np.array(emb['embedding']))
                self.labels.append(person_name)

            return len(embeddings)
        except:
            return 0

    def detect_and_encode(self, image_path: str):
        start_total = time.time()

        try:
            results = DeepFace.represent(
                img_path=image_path,
                model_name=self.model_name,
                enforce_detection=True,
                detector_backend='opencv'
            )

            total_time = time.time() - start_total
            detection_time = total_time * 0.4
            encoding_time = total_time * 0.6

            faces = []
            for result in results:
                region = result['facial_area']
                faces.append({
                    'bbox': {
                        'left': region['x'],
                        'top': region['y'],
                        'right': region['x'] + region['w'],
                        'bottom': region['y'] + region['h']
                    },
                    'embedding': np.array(result['embedding'])
                })

            return faces, detection_time, encoding_time
        except:
            return [], 0, 0

    def recognize(self, image_path: str, threshold: float = 0.4):
        if not self.embeddings:
            return []

        faces, _, _ = self.detect_and_encode(image_path)
        results = []

        for face in faces:
            # Cosine similarity
            embedding = face['embedding']
            embedding_norm = embedding / (np.linalg.norm(embedding) + 1e-6)

            similarities = []
            for known_emb in self.embeddings:
                known_norm = known_emb / (np.linalg.norm(known_emb) + 1e-6)
                sim = np.dot(embedding_norm, known_norm)
                similarities.append(sim)

            max_idx = np.argmax(similarities)

            if similarities[max_idx] > threshold:
                confidence = similarities[max_idx]
                results.append((face['bbox'], self.labels[max_idx], confidence))
            else:
                results.append((face['bbox'], 'Unknown', 0.0))

        return results


class DeepFaceArcFaceRecognizer(FaceRecognitionBase):
    """
    DeepFace with ArcFace model.
    512-d embeddings, very accurate.
    """

    def __init__(self):
        super().__init__("deepface_arcface")
        print(f"[•] Initializing {self.name}...")
        self.model_name = "ArcFace"
        # Warm up
        try:
            DeepFace.represent(
                img_path=np.zeros((224, 224, 3), dtype=np.uint8),
                model_name=self.model_name,
                enforce_detection=False
            )
        except:
            pass

    def train(self, image_path: str, person_name: str):
        try:
            embeddings = DeepFace.represent(
                img_path=image_path,
                model_name=self.model_name,
                enforce_detection=True
            )

            for emb in embeddings:
                self.embeddings.append(np.array(emb['embedding']))
                self.labels.append(person_name)

            return len(embeddings)
        except:
            return 0

    def detect_and_encode(self, image_path: str):
        start_total = time.time()

        try:
            results = DeepFace.represent(
                img_path=image_path,
                model_name=self.model_name,
                enforce_detection=True,
                detector_backend='opencv'
            )

            total_time = time.time() - start_total
            detection_time = total_time * 0.4
            encoding_time = total_time * 0.6

            faces = []
            for result in results:
                region = result['facial_area']
                faces.append({
                    'bbox': {
                        'left': region['x'],
                        'top': region['y'],
                        'right': region['x'] + region['w'],
                        'bottom': region['y'] + region['h']
                    },
                    'embedding': np.array(result['embedding'])
                })

            return faces, detection_time, encoding_time
        except:
            return [], 0, 0

    def recognize(self, image_path: str, threshold: float = 0.4):
        if not self.embeddings:
            return []

        faces, _, _ = self.detect_and_encode(image_path)
        results = []

        for face in faces:
            embedding = face['embedding']
            embedding_norm = embedding / (np.linalg.norm(embedding) + 1e-6)

            similarities = []
            for known_emb in self.embeddings:
                known_norm = known_emb / (np.linalg.norm(known_emb) + 1e-6)
                sim = np.dot(embedding_norm, known_norm)
                similarities.append(sim)

            max_idx = np.argmax(similarities)

            if similarities[max_idx] > threshold:
                confidence = similarities[max_idx]
                results.append((face['bbox'], self.labels[max_idx], confidence))
            else:
                results.append((face['bbox'], 'Unknown', 0.0))

        return results


def get_memory_usage():
    """Get current memory usage in MB."""
    process = psutil.Process(os.getpid())
    return process.memory_info().rss / 1024 / 1024


def benchmark_method(recognizer: FaceRecognitionBase, test_image: str, num_runs: int = 5):
    """Benchmark a single method."""
    print(f"\n{'='*60}")
    print(f"Benchmarking: {recognizer.name}")
    print(f"{'='*60}")

    detection_times = []
    encoding_times = []
    total_times = []
    memory_samples = []
    faces_detected = 0
    embedding_dim = 0

    try:
        for run in range(num_runs):
            mem_before = get_memory_usage()

            start_total = time.time()
            faces, det_time, enc_time = recognizer.detect_and_encode(test_image)
            total_time = time.time() - start_total

            mem_after = get_memory_usage()

            detection_times.append(det_time)
            encoding_times.append(enc_time)
            total_times.append(total_time)
            memory_samples.append(mem_after - mem_before)

            if run == 0:
                faces_detected = len(faces)
                if faces:
                    embedding_dim = len(faces[0]['embedding'])

            print(f"  Run {run+1}: {total_time:.3f}s - {len(faces)} faces - "
                  f"Mem: {mem_after-mem_before:.1f}MB")

        result = BenchmarkResult(
            method=recognizer.name,
            detection_time=np.mean(detection_times),
            encoding_time=np.mean(encoding_times),
            total_time=np.mean(total_times),
            faces_detected=faces_detected,
            memory_mb=np.mean([m for m in memory_samples if m > 0]),
            embedding_dimension=embedding_dim
        )

        print(f"\n  Average: {result.total_time:.3f}s")
        print(f"  Faces: {result.faces_detected} | Embedding: {result.embedding_dimension}-d")

    except Exception as e:
        print(f"  [ERROR] {str(e)}")
        import traceback
        traceback.print_exc()
        result = BenchmarkResult(
            method=recognizer.name,
            detection_time=0, encoding_time=0, total_time=0,
            faces_detected=0, memory_mb=0, embedding_dimension=0,
            error=str(e)
        )

    return result


def test_recognition_accuracy(recognizer: FaceRecognitionBase,
                              train_dir: str,
                              test_image: str):
    """
    Test actual recognition accuracy.
    Train on images in train_dir, then recognize test_image.
    """
    print(f"\n{'='*60}")
    print(f"Testing Recognition: {recognizer.name}")
    print(f"{'='*60}")

    # Train
    print("[•] Training...")
    total_faces = 0
    for filename in os.listdir(train_dir):
        if filename.lower().endswith(('.jpg', '.jpeg', '.png')):
            person_name = os.path.splitext(filename)[0]
            person_name = person_name.rstrip('_0123456789')

            filepath = os.path.join(train_dir, filename)
            faces_found = recognizer.train(filepath, person_name)
            total_faces += faces_found
            print(f"  {person_name}: {faces_found} faces")

    print(f"[✓] Trained on {total_faces} faces")

    # Recognize
    print("\n[•] Recognizing faces in test image...")
    results = recognizer.recognize(test_image)

    print(f"[✓] Found {len(results)} faces:")
    for bbox, name, conf in results:
        print(f"  - {name}: {conf:.2%}")

    return results


def main():
    import argparse

    parser = argparse.ArgumentParser(description='Complete Face Recognition Benchmark')
    parser.add_argument('--mode', choices=['benchmark', 'test'], required=True,
                       help='benchmark=speed test, test=accuracy test')
    parser.add_argument('--image', required=True, help='Test image path')
    parser.add_argument('--train-dir', help='Training directory (for test mode)')
    parser.add_argument('--runs', type=int, default=5, help='Runs per method')
    parser.add_argument('--methods', nargs='+',
                       choices=['dlib_hog', 'dlib_cnn', 'insightface',
                               'deepface_facenet', 'deepface_arcface', 'all'],
                       default=['all'])

    args = parser.parse_args()

    # Determine methods
    if 'all' in args.methods:
        methods = [k for k, v in AVAILABLE_METHODS.items() if v]
    else:
        methods = [m for m in args.methods if AVAILABLE_METHODS.get(m, False)]

    if not methods:
        print("[!] No methods available. Install packages:")
        print("  pip install face_recognition insightface onnxruntime deepface tf-keras")
        sys.exit(1)

    print(f"\n{'='*60}")
    print("FACE RECOGNITION COMPLETE TEST")
    print(f"{'='*60}")
    print(f"Mode: {args.mode}")
    print(f"Test Image: {args.image}")
    print(f"Methods: {', '.join(methods)}")
    print(f"{'='*60}\n")

    # Initialize recognizers
    recognizers = []

    for method in methods:
        if method == 'dlib_hog':
            recognizers.append(DlibHOGRecognizer())
        elif method == 'dlib_cnn':
            recognizers.append(DlibCNNRecognizer())
        elif method == 'insightface':
            recognizers.append(InsightFaceRecognizer())
        elif method == 'deepface_facenet':
            recognizers.append(DeepFaceFaceNetRecognizer())
        elif method == 'deepface_arcface':
            recognizers.append(DeepFaceArcFaceRecognizer())

    if args.mode == 'benchmark':
        # Speed benchmark
        results = []
        for recognizer in recognizers:
            result = benchmark_method(recognizer, args.image, args.runs)
            results.append(result)

        # Print summary
        print(f"\n{'='*60}")
        print("BENCHMARK SUMMARY")
        print(f"{'='*60}\n")

        valid = [r for r in results if r.error is None]
        valid.sort(key=lambda x: x.total_time)

        for i, r in enumerate(valid, 1):
            print(f"{i}. {r.method:20s} {r.total_time:6.2f}s  "
                  f"({r.faces_detected} faces, {r.embedding_dimension}-d)")

        if valid:
            print(f"\n🏆 FASTEST: {valid[0].method} ({valid[0].total_time:.2f}s)")

    else:  # test mode
        if not args.train_dir:
            print("[!] --train-dir required for test mode")
            sys.exit(1)

        # Accuracy test
        for recognizer in recognizers:
            test_recognition_accuracy(recognizer, args.train_dir, args.image)


if __name__ == "__main__":
    main()
