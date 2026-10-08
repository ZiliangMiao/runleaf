"""Deeplore extensions to MLflow.

Modules:
- ``dataset_release``: validate, release and archive datasets (git + DVC).
- ``dataset_registry``: datasets, their versions and release jobs in the tracking database.
- ``dataset_api``: dataset REST endpoints and the background release worker.
- ``evaluation_registry``: benchmark evaluations of model files on registered dataset versions.
- ``evaluation_api``: evaluation REST endpoints.
- ``benchmark_api``: per-experiment benchmark comparison built from evaluations.
- ``run_api``: project-wide run numbers allocated by the server.
- ``monitor_history``: run monitor history.
"""
