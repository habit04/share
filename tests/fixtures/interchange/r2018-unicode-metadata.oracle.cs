using System;
using Autodesk.AutoCAD.ApplicationServices.Core;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.Runtime;
using System.Runtime.Versioning;
[assembly: TargetFramework(".NETCoreApp,Version=v10.0", FrameworkDisplayName = ".NET 10.0")]
[assembly: CommandClass(typeof(JCadUnicodeMetadataOracle))]

public class JCadUnicodeMetadataOracle
{
    [CommandMethod("JCADUNICODEMETADATAFIXTURE")]
    public static void Create()
    {
        Database db = Application.DocumentManager.MdiActiveDocument.Database;
        using (Transaction tr = db.TransactionManager.StartTransaction())
        {
            var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            var model = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForWrite);
            foreach (ObjectId id in model) ((DBObject)tr.GetObject(id, OpenMode.ForWrite)).Erase();
            var line = new Line(new Point3d(100, 200, 0), new Point3d(110, 200, 0));
            model.AppendEntity(line); tr.AddNewlyCreatedDBObject(line, true);
            var line2 = new Line(new Point3d(100, 210, 0), new Point3d(105, 215, 0));
            model.AppendEntity(line2); tr.AddNewlyCreatedDBObject(line2, true);
            var text = new MText { Location = new Point3d(100, 205, 0), TextHeight = 1, Width = 30, Contents = "Drawing Δ雷: filename" };
            model.AppendEntity(text); tr.AddNewlyCreatedDBObject(text, true);
            var field = new Field("Drawing Δ雷: %<\\AcVar Filename \\f \"%fn2\">%", true);
            text.SetField(field); tr.AddNewlyCreatedDBObject(field, true);
            // Use the runtime ObjectId only while creating the native FIELD. AutoCAD
            // serializes a normalized _ObjIdx expression and a typed reference vector.
            var lengthText = new MText { Location = new Point3d(100, 220, 0), TextHeight = 1, Width = 30, Contents = "Length: native object field" };
            model.AppendEntity(lengthText); tr.AddNewlyCreatedDBObject(lengthText, true);
            var objectId = line.ObjectId.OldIdPtr.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture);
            var lengthField = new Field("Length: %<\\AcObjProp Object(%<\\_ObjId " + objectId + ">%).Length \\f \"%lu2%pr4\">%", true);
            lengthText.SetField(lengthField); tr.AddNewlyCreatedDBObject(lengthField, true);
            var vt = (ViewTable)tr.GetObject(db.ViewTableId, OpenMode.ForWrite);
            foreach (var name in new[] { "SITE_NORTH_Δ雷", "SITE_ANGLE_Δ雷", "FUTURE_3D_Δ雷" })
            {
                if (vt.Has(name)) ((DBObject)tr.GetObject(vt[name], OpenMode.ForWrite)).Erase();
                var view = new ViewTableRecord { Name = name, CenterPoint = new Point2d(5, 2.5), Width = 40, Height = 20, Target = new Point3d(100, 200, name == "FUTURE_3D_Δ雷" ? 12 : 7), ViewDirection = name == "FUTURE_3D_Δ雷" ? new Vector3d(1, 2, 3) : Vector3d.ZAxis, ViewTwist = name == "SITE_ANGLE_Δ雷" ? Math.PI / 6 : 0, LensLength = 50 };
                vt.Add(view); tr.AddNewlyCreatedDBObject(view, true);
            }
            var nod = (DBDictionary)tr.GetObject(db.NamedObjectsDictionaryId, OpenMode.ForWrite);
            var app = new DBDictionary(); nod.SetAt("JCAD_METADATA_ORACLE_Δ雷", app); tr.AddNewlyCreatedDBObject(app, true);
            var data = new Xrecord(); app.SetAt("TypedPayload_Δ雷", data); tr.AddNewlyCreatedDBObject(data, true);
            data.Data = new ResultBuffer(new TypedValue(1, "Unicode Δ 雷 F0A \\U+0041 JSON {\"literal\":\"\\\\U+0041\",\"unicode\":\"Δ雷\",\"hex\":\"F0A\"}"), new TypedValue(160, 9007199254740993L), new TypedValue(310, new byte[] { 0, 1, 127, 128, 255 }), new TypedValue(330, line.ObjectId), new TypedValue(340, line2.ObjectId));
            line.CreateExtensionDictionary();
            var extension = (DBDictionary)tr.GetObject(line.ExtensionDictionary, OpenMode.ForWrite);
            var owned = new Xrecord(); extension.SetAt("LinkedMetadata", owned); tr.AddNewlyCreatedDBObject(owned, true);
            owned.Data = new ResultBuffer(new TypedValue(1, "owned by the line"), new TypedValue(330, line2.ObjectId));
            tr.Commit();
        }
        db.EvaluateFields();
        Application.DocumentManager.MdiActiveDocument.Editor.WriteMessage("\nJCAD_NATIVE_FIELDS_CREATED\n");
    }
    [CommandMethod("JCADSAVEUNICODEMETADATA")]
    public static void Save()
    {
        // Pass UTF-16 paths through the native .NET API, not ANSI SCR text.
        var doc = Application.DocumentManager.MdiActiveDocument;
        doc.Editor.Command("_.SAVEAS", "2018", "C:/Users/justi/Chad/jcad-portable-dwg/.codex-local/cad-metadata-oracle/r2018-unicode-metadata-Δ雷.dwg");
        doc.Database.EvaluateFields();
        doc.Editor.Command("_.QSAVE");
        doc.Editor.Command("_.DXFOUT", "C:/Users/justi/Chad/jcad-portable-dwg/.codex-local/cad-metadata-oracle/r2018-unicode-metadata-Δ雷.dxf", "_VERSION", "2018", "16");
    }
    [CommandMethod("JCADVERIFYCURRENTUNICODE")]
    public static void VerifyCurrent()
    {
        var check = Application.DocumentManager.MdiActiveDocument.Database;
        using (var tr = check.TransactionManager.StartTransaction())
        {
            var views = (ViewTable)tr.GetObject(check.ViewTableId, OpenMode.ForRead);
            if (!views.Has("SITE_ANGLE_Δ雷")) throw new System.Exception("Native Unicode VIEW name changed");
            var nod = (DBDictionary)tr.GetObject(check.NamedObjectsDictionaryId, OpenMode.ForRead);
            var app = (DBDictionary)tr.GetObject(nod.GetAt("JCAD_METADATA_ORACLE_Δ雷"), OpenMode.ForRead);
            var data = (Xrecord)tr.GetObject(app.GetAt("TypedPayload_Δ雷"), OpenMode.ForRead);
            var actual = (string)data.Data.AsArray()[0].Value;
            var actualBase64 = Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes(actual));
            Application.DocumentManager.MdiActiveDocument.Editor.WriteMessage("\nJCAD_UNICODE_LITERAL_B64=" + actualBase64 + "\n");
            var wanted = "Unicode Δ 雷 F0A \\U+0041 JSON {\"literal\":\"\\\\U+0041\",\"unicode\":\"Δ雷\",\"hex\":\"F0A\"}";
            if (actual != wanted) throw new System.Exception("Native Unicode/literal XRECORD text changed");
            Application.DocumentManager.MdiActiveDocument.Editor.WriteMessage("\nJCAD_UNICODE_NATIVE_REOPEN_VERIFIED\n");
        }
    }
    [CommandMethod("JCADVERIFYUNICODEMETADATA")]
    public static void Verify()
    {
        using (var check = new Database(false, true))
        {
            check.ReadDwgFile("C:/Users/justi/Chad/jcad-portable-dwg/.codex-local/cad-metadata-oracle/r2018-unicode-metadata-Δ雷.dwg", FileOpenMode.OpenForReadAndReadShare, true, null);
            using (var tr = check.TransactionManager.StartTransaction())
            {
                var views = (ViewTable)tr.GetObject(check.ViewTableId, OpenMode.ForRead);
                if (!views.Has("SITE_ANGLE_Δ雷")) throw new System.Exception("Native Unicode VIEW name changed");
                var nod = (DBDictionary)tr.GetObject(check.NamedObjectsDictionaryId, OpenMode.ForRead);
                var app = (DBDictionary)tr.GetObject(nod.GetAt("JCAD_METADATA_ORACLE_Δ雷"), OpenMode.ForRead);
                var data = (Xrecord)tr.GetObject(app.GetAt("TypedPayload_Δ雷"), OpenMode.ForRead);
                var literal = "Unicode Δ 雷 F0A \\U+0041 JSON {\"literal\":\"\\\\U+0041\",\"unicode\":\"Δ雷\",\"hex\":\"F0A\"}";
                if ((string)data.Data.AsArray()[0].Value != literal) throw new System.Exception("Native Unicode/literal XRECORD text changed");
                var base64 = Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes(literal));
                Application.DocumentManager.MdiActiveDocument.Editor.WriteMessage("\nJCAD_UNICODE_LITERAL_B64=" + base64 + "\nJCAD_UNICODE_NATIVE_REOPEN_VERIFIED\n");
            }
        }
    }
}
