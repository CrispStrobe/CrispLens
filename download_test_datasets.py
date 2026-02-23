#!/usr/bin/env python3
"""
download_test_datasets.py - FIXED VERSION
"""

import os
import urllib.request
import tarfile
import zipfile
import shutil
from pathlib import Path
import cv2
import numpy as np
from tqdm import tqdm
import random

def download_file(url, output_path):
    """Download file with progress bar."""
    print(f"[•] Downloading {os.path.basename(output_path)}...")
    
    def reporthook(blocknum, blocksize, totalsize):
        readsofar = blocknum * blocksize
        if totalsize > 0:
            percent = readsofar * 100 / totalsize
            s = f"\r{percent:5.1f}% {readsofar:,} / {totalsize:,} bytes"
            print(s, end='')
            if readsofar >= totalsize:
                print()
        else:
            print(f"\r{readsofar:,} bytes", end='')
    
    urllib.request.urlretrieve(url, output_path, reporthook)
    print("[✓] Download complete")


def download_att_faces(output_dir="datasets/att_faces"):
    """
    Download AT&T Database of Faces.
    40 people, 10 images each.
    """
    os.makedirs(output_dir, exist_ok=True)
    
    url = "https://www.cl.cam.ac.uk/Research/DTG/attarchive/pub/data/att_faces.zip"
    zip_path = os.path.join(output_dir, "att_faces.zip")
    
    if not os.path.exists(zip_path):
        download_file(url, zip_path)
    
    print("[•] Extracting...")
    with zipfile.ZipFile(zip_path, 'r') as zip_ref:
        zip_ref.extractall(output_dir)
    
    print("[✓] AT&T Faces dataset ready!")
    return output_dir


def create_synthetic_group_photo(face_images, output_path, grid_size=(6, 5)):
    """
    Create a synthetic group photo by combining multiple face images.
    """
    rows, cols = grid_size
    target_face_size = (120, 120)
    margin = 10
    
    # Calculate canvas size
    canvas_width = cols * (target_face_size[0] + margin) + margin
    canvas_height = rows * (target_face_size[1] + margin) + margin
    
    # Create canvas
    canvas = np.ones((canvas_height, canvas_width, 3), dtype=np.uint8) * 240
    
    # Place faces
    placed = 0
    for i, face_path in enumerate(face_images[:rows*cols]):
        row = i // cols
        col = i % cols
        
        # Read and resize face
        img = cv2.imread(str(face_path))
        if img is None:
            continue
        
        img_resized = cv2.resize(img, target_face_size)
        
        # Calculate position
        y = row * (target_face_size[1] + margin) + margin
        x = col * (target_face_size[0] + margin) + margin
        
        # Place on canvas
        canvas[y:y+target_face_size[1], x:x+target_face_size[0]] = img_resized
        placed += 1
    
    cv2.imwrite(output_path, canvas)
    print(f"  [✓] Created group photo with {placed} faces")
    return output_path


def quick_setup_att():
    """
    Quick setup using AT&T faces only.
    FIXED VERSION - handles actual directory structure.
    """
    print("="*60)
    print("QUICK SETUP - AT&T Faces")
    print("="*60)
    
    # Download AT&T
    print("\n[1/3] Downloading AT&T Faces...")
    att_dir = download_att_faces()
    
    # Create training directory
    print("\n[2/3] Preparing training set...")
    training_dir = "datasets/quick_training"
    os.makedirs(training_dir, exist_ok=True)
    
    # Find all person directories (they're directly in att_dir)
    person_dirs = [d for d in os.listdir(att_dir) 
                   if os.path.isdir(os.path.join(att_dir, d)) and d.startswith('s')]
    
    print(f"  Found {len(person_dirs)} people")
    
    if not person_dirs:
        print("[!] ERROR: No person directories found!")
        print(f"    Contents of {att_dir}:")
        print(f"    {os.listdir(att_dir)}")
        return None
    
    # Copy first 5 images from each person
    total_copied = 0
    for person_id in sorted(person_dirs):
        person_path = os.path.join(att_dir, person_id)
        
        # Get all images in this person's directory
        images = sorted([f for f in os.listdir(person_path) 
                        if f.endswith('.pgm')])
        
        # Copy first 5 images
        for i, img_name in enumerate(images[:5], 1):
            src = os.path.join(person_path, img_name)
            dst = os.path.join(training_dir, f"person_{person_id}_{i}.pgm")
            shutil.copy(src, dst)
            total_copied += 1
    
    print(f"  [✓] Copied {total_copied} training images from {len(person_dirs)} people")
    
    # Create test group photos
    print("\n[3/3] Creating test group photos...")
    group_dir = "datasets/quick_groups"
    os.makedirs(group_dir, exist_ok=True)
    
    all_training_images = [os.path.join(training_dir, f) 
                          for f in os.listdir(training_dir)]
    
    if len(all_training_images) < 20:
        print(f"[!] Warning: Only {len(all_training_images)} images available")
    
    # Create 3 different group sizes
    group_configs = [
        (20, (5, 4)),   # 20 people in 5x4 grid
        (30, (6, 5)),   # 30 people in 6x5 grid
        (min(40, len(all_training_images)), (8, 5))  # Up to 40 people
    ]
    
    for group_num, (target_size, grid) in enumerate(group_configs, 1):
        actual_size = min(target_size, len(all_training_images))
        selected = random.sample(all_training_images, actual_size)
        
        output_path = os.path.join(group_dir, f"group_{group_num}_{actual_size}people.jpg")
        create_synthetic_group_photo(selected, output_path, grid_size=grid)
    
    print("\n" + "="*60)
    print("QUICK SETUP COMPLETE!")
    print("="*60)
    print(f"\n📁 Datasets created:")
    print(f"   Training faces:  {training_dir} ({total_copied} images)")
    print(f"   Test groups:     {group_dir} (3 group photos)")
    
    print(f"\n🚀 Ready to benchmark!")
    print(f"\n1. Test on small group (20 people):")
    print(f"   python face_recognition_benchmark.py \\")
    print(f"     --mode benchmark \\")
    print(f"     --image {group_dir}/group_1_20people.jpg \\")
    print(f"     --methods insightface dlib_hog \\")
    print(f"     --runs 3")
    
    print(f"\n2. Test on large group (30-40 people):")
    print(f"   python face_recognition_benchmark.py \\")
    print(f"     --mode benchmark \\")
    print(f"     --image {group_dir}/group_3_*people.jpg \\")
    print(f"     --methods insightface \\")
    print(f"     --runs 3")
    
    print(f"\n3. Test recognition accuracy:")
    print(f"   python face_recognition_benchmark.py \\")
    print(f"     --mode test \\")
    print(f"     --image {group_dir}/group_1_20people.jpg \\")
    print(f"     --train-dir {training_dir} \\")
    print(f"     --methods insightface")
    
    return {
        'training': training_dir,
        'groups': group_dir,
        'att': att_dir
    }


def download_lfw_dataset(output_dir="datasets/lfw"):
    """
    Download Labeled Faces in the Wild dataset.
    """
    os.makedirs(output_dir, exist_ok=True)
    
    url = "http://vis-www.cs.umass.edu/lfw/lfw.tgz"
    tar_path = os.path.join(output_dir, "lfw.tgz")
    
    if not os.path.exists(tar_path):
        download_file(url, tar_path)
    
    print("[•] Extracting...")
    with tarfile.open(tar_path, 'r:gz') as tar:
        tar.extractall(output_dir)
    
    print("[✓] LFW dataset ready!")
    return os.path.join(output_dir, "lfw")


def prepare_training_set(lfw_dir, output_dir="datasets/training_faces", num_people=50, images_per_person=5):
    """
    Create a clean training set from LFW.
    """
    os.makedirs(output_dir, exist_ok=True)
    
    print(f"[•] Preparing training set: {num_people} people, {images_per_person} images each...")
    
    lfw_path = Path(lfw_dir)
    people_dirs = [d for d in lfw_path.iterdir() if d.is_dir()]
    
    # Filter people with enough images
    suitable_people = []
    for person_dir in people_dirs:
        images = list(person_dir.glob("*.jpg"))
        if len(images) >= images_per_person:
            suitable_people.append((person_dir.name, images))
    
    if len(suitable_people) < num_people:
        print(f"[!] Warning: Only {len(suitable_people)} people have {images_per_person}+ images")
        num_people = len(suitable_people)
    
    # Randomly select people
    random.shuffle(suitable_people)
    selected_people = suitable_people[:num_people]
    
    count = 0
    for person_name, images in tqdm(selected_people, desc="Copying images"):
        for i, img_path in enumerate(images[:images_per_person]):
            output_name = f"{person_name}_{i+1}.jpg"
            shutil.copy(img_path, os.path.join(output_dir, output_name))
            count += 1
    
    print(f"[✓] Training set ready: {count} images from {num_people} people")
    return output_dir


def prepare_test_set(lfw_dir, training_dir, output_dir="datasets/test_faces", num_images=20):
    """
    Create test set with single faces (not in training set).
    """
    os.makedirs(output_dir, exist_ok=True)
    
    print(f"[•] Preparing test set: {num_images} single-face images...")
    
    training_files = os.listdir(training_dir)
    training_people = set([f.rsplit('_', 1)[0] for f in training_files])
    
    lfw_path = Path(lfw_dir)
    people_dirs = [d for d in lfw_path.iterdir() if d.is_dir()]
    
    test_images = []
    for person_dir in people_dirs:
        if person_dir.name not in training_people:
            images = list(person_dir.glob("*.jpg"))
            if images:
                test_images.append(random.choice(images))
        
        if len(test_images) >= num_images:
            break
    
    for i, img_path in enumerate(test_images):
        shutil.copy(img_path, os.path.join(output_dir, f"test_{i+1}.jpg"))
    
    print(f"[✓] Test set ready: {len(test_images)} images")
    return output_dir


def prepare_group_test_photos(training_dir, output_dir="datasets/test_groups", num_groups=5):
    """
    Create synthetic group photos from training faces.
    """
    os.makedirs(output_dir, exist_ok=True)
    
    print(f"[•] Creating {num_groups} synthetic group photos...")
    
    training_images = [os.path.join(training_dir, f) for f in os.listdir(training_dir) 
                       if f.endswith(('.jpg', '.jpeg', '.png'))]
    
    if len(training_images) < 20:
        print("[!] Not enough training images for group photos")
        return output_dir
    
    for i in range(num_groups):
        group_size = random.randint(20, min(30, len(training_images)))
        selected_faces = random.sample(training_images, group_size)
        
        output_path = os.path.join(output_dir, f"group_{i+1}_{group_size}people.jpg")
        create_synthetic_group_photo(selected_faces, output_path)
    
    print(f"[✓] Group photos ready!")
    return output_dir


def full_setup():
    """
    Full setup with LFW dataset.
    """
    print("="*60)
    print("FULL SETUP - LFW Dataset")
    print("="*60)
    
    # Download LFW
    print("\n[1/5] Downloading LFW dataset...")
    lfw_dir = download_lfw_dataset()
    
    # Download AT&T
    print("\n[2/5] Downloading AT&T Faces dataset...")
    att_dir = download_att_faces()
    
    # Prepare training set
    print("\n[3/5] Preparing training set...")
    training_dir = prepare_training_set(lfw_dir, num_people=50, images_per_person=5)
    
    # Prepare test set
    print("\n[4/5] Preparing test set...")
    test_dir = prepare_test_set(lfw_dir, training_dir, num_images=20)
    
    # Create group photos
    print("\n[5/5] Creating synthetic group photos...")
    group_dir = prepare_group_test_photos(training_dir, num_groups=5)
    
    print("\n" + "="*60)
    print("FULL SETUP COMPLETE!")
    print("="*60)
    print(f"\n📁 Datasets created:")
    print(f"   Training faces:  {training_dir}")
    print(f"   Test faces:      {test_dir}")
    print(f"   Group photos:    {group_dir}")
    print(f"   LFW (full):      {lfw_dir}")
    print(f"   AT&T Faces:      {att_dir}")
    
    print(f"\n🚀 Ready to benchmark!")
    print(f"   python face_recognition_benchmark.py \\")
    print(f"     --mode benchmark \\")
    print(f"     --image {group_dir}/group_1_20people.jpg \\")
    print(f"     --methods all \\")
    print(f"     --runs 5")
    
    return {
        'training': training_dir,
        'test': test_dir,
        'groups': group_dir,
        'lfw': lfw_dir,
        'att': att_dir
    }


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Download and setup face recognition datasets")
    parser.add_argument('--quick', action='store_true', 
                       help='Quick setup with AT&T faces only')
    
    args = parser.parse_args()
    
    try:
        if args.quick:
            result = quick_setup_att()
        else:
            result = full_setup()
        
        if result:
            print("\n✅ All done! Start benchmarking now.")
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        print("\n💡 Tip: Check your internet connection and try again")