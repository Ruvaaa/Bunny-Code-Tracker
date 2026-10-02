from PIL import Image
from pathlib import Path


# -----------------------------------------
# Folders
# -----------------------------------------

source_folder = Path("assets/bunny/inline")
output_folder = Path("assets/bunny/inline_cropped")

output_folder.mkdir(exist_ok=True)


# -----------------------------------------
# Transparent padding
# -----------------------------------------

PADDING = 1


# -----------------------------------------
# Crop every already-resized PNG
# -----------------------------------------

for image_path in source_folder.glob("*.png"):

    image = Image.open(image_path).convert("RGBA")


    # Find visible pixels
    alpha = image.getchannel("A")

    bbox = alpha.getbbox()


    # Skip completely transparent images
    if bbox is None:

        print(
            f"Skipped empty image: {image_path.name}"
        )

        continue


    # Crop to visible bunny
    left, top, right, bottom = bbox


    left = max(0, left - PADDING)
    top = max(0, top - PADDING)
    right = min(image.width, right + PADDING)
    bottom = min(image.height, bottom + PADDING)


    cropped = image.crop(
        (left, top, right, bottom)
    )


    # Save
    output_path = (
        output_folder /
        image_path.name
    )


    cropped.save(
        output_path,
        "PNG"
    )


    print(
        f"{image_path.name}: "
        f"{image.size} → "
        f"{cropped.size}"
    )


print("\nDone! 🐇")