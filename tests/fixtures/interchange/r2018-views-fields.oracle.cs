using System;
using Autodesk.AutoCAD.ApplicationServices.Core;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.Runtime;
using System.Runtime.Versioning;
[assembly: TargetFramework(".NETCoreApp,Version=v10.0", FrameworkDisplayName = ".NET 10.0")]
[assembly: CommandClass(typeof(JCadFixtureOracle))]

public class JCadFixtureOracle
{
    [CommandMethod("JCADMETADATAFIXTURE")]
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
            var text = new MText { Location = new Point3d(100, 205, 0), TextHeight = 1, Width = 30, Contents = "Drawing: filename" };
            model.AppendEntity(text); tr.AddNewlyCreatedDBObject(text, true);
            var field = new Field("Drawing: %<\\AcVar Filename \\f \"%fn2\">%", true);
            text.SetField(field); tr.AddNewlyCreatedDBObject(field, true);
            var vt = (ViewTable)tr.GetObject(db.ViewTableId, OpenMode.ForWrite);
            foreach (var name in new[] { "SITE_NORTH", "SITE_ANGLE", "FUTURE_3D" })
            {
                if (vt.Has(name)) ((DBObject)tr.GetObject(vt[name], OpenMode.ForWrite)).Erase();
                var view = new ViewTableRecord { Name = name, CenterPoint = new Point2d(5, 2.5), Width = 40, Height = 20, Target = new Point3d(100, 200, name == "FUTURE_3D" ? 12 : 7), ViewDirection = name == "FUTURE_3D" ? new Vector3d(1, 2, 3) : Vector3d.ZAxis, ViewTwist = name == "SITE_ANGLE" ? Math.PI / 6 : 0, LensLength = 50 };
                vt.Add(view); tr.AddNewlyCreatedDBObject(view, true);
            }
            var nod = (DBDictionary)tr.GetObject(db.NamedObjectsDictionaryId, OpenMode.ForWrite);
            var app = new DBDictionary(); nod.SetAt("JCAD_METADATA_ORACLE", app); tr.AddNewlyCreatedDBObject(app, true);
            var data = new Xrecord(); app.SetAt("TypedPayload", data); tr.AddNewlyCreatedDBObject(data, true);
            data.Data = new ResultBuffer(new TypedValue(1, "Payload F0A is literal text"), new TypedValue(160, 9007199254740993L), new TypedValue(310, new byte[] { 0, 1, 127, 128, 255 }), new TypedValue(330, line.ObjectId), new TypedValue(340, line2.ObjectId));
            line.CreateExtensionDictionary();
            var extension = (DBDictionary)tr.GetObject(line.ExtensionDictionary, OpenMode.ForWrite);
            var owned = new Xrecord(); extension.SetAt("LinkedMetadata", owned); tr.AddNewlyCreatedDBObject(owned, true);
            owned.Data = new ResultBuffer(new TypedValue(1, "owned by the line"), new TypedValue(330, line2.ObjectId));
            tr.Commit();
        }
        db.EvaluateFields();
        Application.DocumentManager.MdiActiveDocument.Editor.WriteMessage("\nJCAD_NATIVE_FIELDS_CREATED\n");
    }
}
