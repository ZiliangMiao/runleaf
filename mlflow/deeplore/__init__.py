"""Deeplore extensions to MLflow.

Modules:
- ``dataset_release``: validate, release and archive datasets (git + DVC).
- ``dataset_registry``: datasets, their versions and release jobs in the tracking database.
- ``dataset_api``: dataset REST endpoints and the background release worker.
- ``evaluation_registry``: benchmark evaluations of model files on registered dataset versions.
- ``evaluation_api``: evaluation REST endpoints.
- ``benchmark_api``: per-experiment benchmark comparison built from evaluations.
- ``project_api``: projects, the experiments they own and their server-allocated run numbers.
- ``monitor_history``: run monitor history.
"""
