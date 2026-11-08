"""Core TAGT model, data loading and feature preprocessing shared by training and the web app.

The architecture mirrors the layer layout of the original ``models/best_tagt_model.pt``
checkpoint (gene encoder -> graph projection -> attention -> clinical fusion -> classifier),
with a 2-feature clinical encoder (current SLEDAI and current flare status).
"""
from __future__ import annotations

import pickle
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
ARTIFACT_DIR = Path(__file__).resolve().parent / "artifacts"

CLINICAL_FEATURES = ["current_sledai", "current_flare"]


class TAGTModel(nn.Module):
    """Temporal Attention Graph Transformer (compact variant used for deployment)."""

    def __init__(self, n_genes: int = 1000, clinical_dim: int = 2, dropout: float = 0.3,
                 input_dropout: float = 0.7):
        super().__init__()
        # Heavy input dropout regularises the 1000-probe branch: with ~380 samples the
        # unregularised network overfits the expression data (CV AUC 0.54 vs 0.60).
        self.gene_encoder = nn.Sequential(
            nn.Dropout(input_dropout),
            nn.Linear(n_genes, 256), nn.ReLU(), nn.Dropout(dropout), nn.Linear(256, 128)
        )
        self.graph_conv = nn.Linear(128, 128)
        self.temporal_attention = nn.MultiheadAttention(128, num_heads=8, batch_first=True)
        self.clinical_encoder = nn.Sequential(nn.Linear(clinical_dim, 32), nn.ReLU())
        self.classifier = nn.Sequential(
            nn.Linear(160, 128), nn.ReLU(), nn.Dropout(dropout),
            nn.Linear(128, 64), nn.ReLU(), nn.Dropout(dropout),
            nn.Linear(64, 1),
        )

    def forward(self, genes: torch.Tensor, clinical: torch.Tensor) -> torch.Tensor:
        """Return the flare logit, shape [batch]."""
        g = torch.relu(self.graph_conv(self.gene_encoder(genes))).unsqueeze(1)
        attn, _ = self.temporal_attention(g, g, g)
        fused = torch.cat([attn.squeeze(1), self.clinical_encoder(clinical)], dim=1)
        return self.classifier(fused).squeeze(-1)


def load_dataset():
    """Load the semi-synthetic visit sequences.

    Expression vectors are real GSE49454 profiles; patient visits, SLEDAI scores and flare labels
    were simulated by ``src/data/process_real_data.py`` (expression assigned to visits at random).

    Returns a dict with gene matrix X [n, 1000], clinical matrix C [n, 2],
    labels y (flare at the next visit), patient groups, probe ids and the raw records.
    """
    with open(DATA_DIR / "integrated" / "sequences_real.pkl", "rb") as f:
        records = pickle.load(f)
    labels = np.load(DATA_DIR / "integrated" / "labels_real.npy").astype(int)
    with open(DATA_DIR / "processed" / "gene_list_real.pkl", "rb") as f:
        probes = [p.strip('"') for p in pickle.load(f)]

    X = np.stack([r["expression"] for r in records]).astype(np.float32)
    C = np.array([[float(r["current_sledai"]), float(r["current_flare"])] for r in records], np.float32)
    groups = np.array([r["patient_id"] for r in records])
    return {"X": X, "C": C, "y": labels, "groups": groups, "probes": probes, "records": records}


class Preprocessor:
    """Standardises gene expression per probe and scales clinical inputs."""

    def __init__(self, gene_mean=None, gene_std=None):
        self.gene_mean = gene_mean
        self.gene_std = gene_std

    def fit(self, X: np.ndarray) -> "Preprocessor":
        self.gene_mean = X.mean(axis=0)
        self.gene_std = X.std(axis=0) + 1e-6
        return self

    def genes(self, X: np.ndarray) -> np.ndarray:
        return ((X - self.gene_mean) / self.gene_std).astype(np.float32)

    @staticmethod
    def clinical(C: np.ndarray) -> np.ndarray:
        C = np.asarray(C, np.float32).copy()
        C[:, 0] = C[:, 0] / 20.0  # SLEDAI-2K roughly spans 0-20+ in this cohort
        return C

    def state(self) -> dict:
        return {"gene_mean": self.gene_mean.tolist(), "gene_std": self.gene_std.tolist()}

    @classmethod
    def from_state(cls, s: dict) -> "Preprocessor":
        return cls(np.array(s["gene_mean"], np.float32), np.array(s["gene_std"], np.float32))
