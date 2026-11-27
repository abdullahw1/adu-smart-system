# Docker Compose runs for the three stacks.
#
#   make up                     dev stack (default): demo clip, no cameras or HDD needed
#   make up STACK=detect        detection-only stack on the edge box (live today)
#   make up STACK=prod          production stack (via systemd, after the HDD check)
#   make build | down | clean   same STACK choice
#   make up SERVICES="face-watch"   only some services
#
# STACK=dev also honours the port overrides in docker-compose.dev.yml
# (DEV_GO2RTC_PORT=11984 make up ...) to run next to the live stack.
#
# Data is never deleted by any target: the face library (runtime/), app data,
# recordings on the HDD, Frigate config and the demo clip all live in host
# folders that `clean` leaves alone.

STACK ?= dev
SERVICES ?=
COMPOSE ?= docker compose

ifeq ($(STACK),dev)
  FILE := docker-compose.dev.yml
else ifeq ($(STACK),detect)
  FILE := docker-compose.detect.yml
else ifeq ($(STACK),prod)
  FILE := docker-compose.yml
else
  $(error STACK must be dev, detect or prod (got "$(STACK)"))
endif

DC := $(COMPOSE) -f $(FILE)
# detect and prod share one Compose project (prod supersedes detect on the same
# box), so only the dev stack, which has its own project, removes orphans:
# elsewhere that would take down the other stack's containers.
ORPHANS := $(if $(filter dev,$(STACK)),--remove-orphans)
DEMO_CLIP := demo/media/cam_03.mp4
RECORDING ?= $(HOME)/patient-watch-recordings/rec1

.DEFAULT_GOAL := help
.PHONY: help build up down clean demo-clip

help: ## Show the targets
	@echo "Usage: make <target> [STACK=dev|detect|prod] [SERVICES=\"...\"]   (now: STACK=$(STACK) -> $(FILE))"
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

build: ## Build the stack's own images (patient-watch, face-watch, app in prod)
	$(DC) build --pull $(SERVICES)

up: $(if $(filter dev,$(STACK)),$(DEMO_CLIP)) ## Start the stack in the background (builds what's missing)
ifeq ($(STACK),prod)
	@# systemd owns production: it checks the HDD is mounted before Docker can
	@# bind a folder on the OS disk, and restarts the stack if it stops.
	sudo systemctl start adu.service
	@systemctl --no-pager --lines=0 status adu.service || true
else
	$(DC) up -d --build $(SERVICES)
	@$(DC) ps
endif

down: ## Stop and remove the stack's containers (data is kept)
ifeq ($(STACK),prod)
	sudo systemctl stop adu.service
else
	$(DC) down $(ORPHANS) $(if $(SERVICES),$(SERVICES))
endif

clean: ## down + remove the stack's built images, networks and anonymous volumes (data is kept)
ifeq ($(STACK),prod)
	-sudo systemctl stop adu.service
endif
	$(DC) down $(ORPHANS) --rmi local --volumes

# The dev stack's demo camera. Built once from a patient-watch recording
# (see demo/make-demo-video.sh); RECORDING=... picks another one.
$(DEMO_CLIP):
	@test -d "$(RECORDING)/frames" || { echo "No demo clip yet and no recording at $(RECORDING)."; \
	  echo "Record one with patient-watch/record.py, then: make up RECORDING=<folder>"; exit 1; }
	demo/make-demo-video.sh "$(RECORDING)" $@

demo-clip: $(DEMO_CLIP) ## Build the dev stack's demo clip from RECORDING (once)
