# PPQ Privacy Verifier

A proxy that runs on your machine and encrypts your AI queries before they
leave it. It does two things, depending on the model you ask for.

## 1. Encrypts queries to PPQ's AWS Nitro enclave

For frontier models like Claude, GPT and Gemini, the proxy encrypts your query
with EHBP to PPQ's AWS Nitro enclave. The query is decrypted only inside that
enclave, which forwards it to the model's provider.

PPQ cannot read your query. The model's provider can.

## 2. Encrypts queries to Tinfoil

For `private/*` models, the proxy encrypts your query with EHBP to a
[Tinfoil](https://tinfoil.sh) enclave, where the model itself runs. The query
passes through PPQ's API, which bills your key and relays the ciphertext, and
is decrypted only inside Tinfoil's enclave.

Nobody but you can read your query. Not PPQ, and not Tinfoil.
