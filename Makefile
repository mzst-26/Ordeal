PYTHON ?= .venv-spine/bin/python
# Calibration files (calib_cache.jsonl, calibration*.json, screen.json) go to scratch/calibration/, not the root.
# scratch/ is not tracked in git, so saved replies never end up in a commit.
CALIBRATION_OUT_DIR ?= scratch/calibration

.PHONY: calibrate-baseline calibrate-screen test

calibrate-baseline:
	$(PYTHON) -m ordeal.calibrate baseline --suite gauntlet_v4+hard --repeats 4 \
		--lo 0.3 --hi 0.9 --model nvidia/nemotron-3-super-120b-a12b --out-dir $(CALIBRATION_OUT_DIR)

calibrate-screen:
	$(PYTHON) -m ordeal.calibrate screen --suite gauntlet_v4+hard --repeats 4 \
		--model nvidia/nemotron-3-super-120b-a12b --out-dir $(CALIBRATION_OUT_DIR)

test:
	$(PYTHON) -m unittest discover -s tests/python -t .
