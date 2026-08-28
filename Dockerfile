# Audiveris' bundled Windows JRE is 25 (see tools/Audiveris/Audiveris/runtime/release);
# eclipse-temurin publishes matching Linux JRE images, so we build on top of
# that instead of installing a JDK via apt (Debian/Ubuntu repos lag new releases).
FROM eclipse-temurin:25-jre-jammy

# Python for the FastAPI backend, plus a Unicode font with the flat/sharp
# glyphs the note labels use (Arial Unicode MS is Windows-only and not
# redistributable - annotate.py falls back to this on non-Windows, see
# LABEL_FONT_PATH below).
#
# libgtk-3-0 is needed too: Audiveris's WellKnowns class unconditionally probes
# GTK for HiDPI-scaling info at startup on Linux (unused in headless -batch
# mode, but the JNA lookup still fails without the library present at all).
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip \
        fonts-dejavu-core \
        libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*
ENV LABEL_FONT_PATH=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bundled Audiveris OMR engine (see run.py). Its jars are pure Java and
# cross-platform except two native (image I/O / OCR) ones, which are
# Windows-only in the bundle - those are dropped and the Linux equivalents
# fetched from Maven Central instead.
#
# tools/Audiveris/ is .gitignored (AGPL-3.0, ~166MB - see README "Setup") and
# is NOT fetched by this Dockerfile: it must already exist in the local build
# context before `docker build` runs here - present already for a local dev
# build, or fetched from S3 by the release workflow's "Fetch Audiveris" step
# for a CI build (harmless overlap: the two lines below then just re-swap
# jars that are already in their Linux form).
COPY tools/Audiveris/Audiveris/app/ ./tools/Audiveris/Audiveris/app/
RUN rm -f ./tools/Audiveris/Audiveris/app/*-windows-x86_64.jar
ADD https://repo1.maven.org/maven2/org/bytedeco/leptonica/1.87.0-1.5.13/leptonica-1.87.0-1.5.13-linux-x86_64.jar \
    https://repo1.maven.org/maven2/org/bytedeco/tesseract/5.5.2-1.5.13/tesseract-5.5.2-1.5.13-linux-x86_64.jar \
    ./tools/Audiveris/Audiveris/app/

COPY annotate.py audiveris_heads.py labels.py omr_notes.py run.py server.py auth.py db.py storage.py ./
COPY static/ ./static/

EXPOSE 8000
CMD ["python3", "server.py"]
