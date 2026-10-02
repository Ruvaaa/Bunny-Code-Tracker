from PIL import Image
from pathlib import Path


# -----------------------------------------
# Folders
# -----------------------------------------

source_folder = Path("assets/bunny/inline_cropped")
output_folder = source_folder / "resized"

output_folder.mkdir(exist_ok=True)


# -----------------------------------------
# Target size
# -----------------------------------------

SIZE = (18, 18)


# -----------------------------------------
# Resize all PNGs
# -----------------------------------------

for image_path in source_folder.glob("*.png"):

    image = Image.open(image_path)

    resized = image.resize(
        SIZE,
        Image.Resampling.NEAREST
    )

    output_path = output_folder / image_path.name

    resized.save(
        output_path,
        "PNG"
    )

    print(
        f"Resized: {image_path.name} → {output_path}"
    )


print("\nDone! 🐇")