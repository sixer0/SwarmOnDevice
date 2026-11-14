# Bab uji impor diagram

Paragraf pembuka sintetis alfa bravo charlie.

```diagram
{
  "family": "flow",
  "labels_verified": true,
  "nodes": [
    {
      "id": "a",
      "label": "Terima",
      "class": {
        "col": 0,
        "row": 0
      }
    },
    {
      "id": "b",
      "label": "Periksa",
      "class": {
        "col": 0,
        "row": 1
      }
    },
    {
      "id": "c",
      "label": "Kirim",
      "class": {
        "col": 0,
        "row": 2
      }
    }
  ],
  "edges": [
    {
      "from": "a",
      "to": "b",
      "kind": "data",
      "label": "isi"
    },
    {
      "from": "b",
      "to": "c",
      "kind": "data",
      "label": "lolos"
    }
  ]
}
```

Gambar: Alur sintetis penerimaan barang.

Sumber: Sumber sintetis uji.

Paragraf tengah sintetis delta echo.

```json
{
  "type": "diagram",
  "spec": {
    "family": "flow",
    "labels_verified": true,
    "nodes": [
      {
        "id": "p",
        "label": "Masuk",
        "class": {
          "col": 0,
          "row": 0
        }
      },
      {
        "id": "q",
        "label": "Simpan",
        "class": {
          "col": 0,
          "row": 1
        }
      }
    ],
    "edges": [
      {
        "from": "p",
        "to": "q",
        "kind": "data",
        "label": "data"
      }
    ]
  },
  "caption": {
    "text": "Alur sintetis penyimpanan."
  },
  "source": {
    "text": "Sumber sintetis uji."
  }
}
```

```json
{
  "type": "table",
  "rows": [
    [
      "Kode",
      "Uraian"
    ],
    [
      "UJI-01",
      "alfa"
    ],
    [
      "UJI-02",
      "bravo"
    ]
  ]
}
```

```
baris kode biasa sintetis
tanpa bahasa
```

Paragraf penutup sintetis foxtrot golf.
