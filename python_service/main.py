
from fastapi import FastAPI, UploadFile, File
import uvicorn
import os

app = FastAPI()

# MOCK_MODE: Set to True if no GPU is available or for fast dev
MOCK_MODE = os.getenv("MOCK_MODE", "True").lower() == "true"

@app.get("/")
def read_root():
    return {"status": "ok", "service": "nougat-extraction", "mock_mode": MOCK_MODE}

@app.post("/extract")
async def extract_latex(file: UploadFile = File(...)):
    """
    Accepts a PDF file and returns the raw LaTeX string.
    """
    if MOCK_MODE:
        return {
            "latex": r"""
\section*{Alice Barista}
\begin{center}
123 Coffee Lane, Jersey City, NJ | (555) 012-3456 | alice@example.com
\end{center}

\section*{Experience}
\begin{itemize}
    \item \textbf{Barista}, Joe's Coffee (2021--Present): 
    Managed espresso bar during morning rush (300+ tickets/day). 
    Trained 5 new staff members on La Marzocco machines.
    
    \item \textbf{Cashier}, The Bagel Shop (2019--2021): 
    Handled POS transactions and closing duties.
\end{itemize}

\section*{Skills}
\begin{tabular}{ll}
    Coffee & Espresso, Latte Art, Pour Over \\
    Service & Square POS, Inventory Management \\
\end{tabular}
"""
        }

    # TODO: Implement actual Nougat inference here
    # This requires:
    # 1. Loading the model (facebook/nougat-small)
    # 2. Processing the PDF bytes
    # 3. Generating text
    # For now, we default to Mock to avoid crashing on non-GPU envs.
    return {"latex": "[Real Nougat inference not yet implemented in this stub. Enable Mock Mode.]"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
