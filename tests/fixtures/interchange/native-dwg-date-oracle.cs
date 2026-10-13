using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.Versioning;
using System.Text.Json;
using Autodesk.AutoCAD.ApplicationServices.Core;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Runtime;
[assembly: TargetFramework(".NETCoreApp,Version=v10.0")]
[assembly: CommandClass(typeof(JCadDateOracle))]
public class JCadDateOracle {
 [CommandMethod("JCADDETACHEDDATEORACLE")]
 public static void Read() {
  var directory=Environment.GetEnvironmentVariable("JCAD_NATIVE_DATE_ORACLE_DIRECTORY");
  if(String.IsNullOrEmpty(directory))throw new System.Exception("Missing isolated fixture-copy directory");
  var results = new List<object>();
  foreach(var stem in new string[] {"r2018-views-fields", "r2018-field-object-reference", "r2018-unicode-metadata"}) {
   using(var db = new Database(false, true)) {
    db.ReadDwgFile(Path.Combine(directory,stem+".dwg"), FileOpenMode.OpenForReadAndReadShare, true, null);
    var values = new Dictionary<string,object>();
    foreach(var p in typeof(Database).GetProperties(BindingFlags.Instance | BindingFlags.Public)) {
     var name=p.Name.ToUpperInvariant();
     if(name!="TDCREATE" && name!="TDUCREATE" && name!="TDUPDATE" && name!="TDUUPDATE" && name!="TDINDWG" && name!="TDUSRTIMER")continue;
     var value = p.GetValue(db, null);
     if(value is DateTime) {
      var date=(DateTime)value;
      // AutoCAD DATE uses the calendar Julian day number at midnight, plus day fraction.
      values[name]=new { iso=date.ToString("O",CultureInfo.InvariantCulture), ticks=date.Ticks.ToString(CultureInfo.InvariantCulture), julian=(date.ToOADate()+2415019.0).ToString("R",CultureInfo.InvariantCulture) };
     }else if(value is TimeSpan) {
      var span=(TimeSpan)value;
      values[name]=new { ticks=span.Ticks.ToString(CultureInfo.InvariantCulture), days=span.TotalDays.ToString("R",CultureInfo.InvariantCulture) };
     }else values[name]=new {type=value.GetType().FullName,value=value.ToString()};
    }
    if(values.Count!=6)throw new System.Exception("Missing stored date properties: "+values.Count);
    results.Add(new {stem=stem,values=values});
   }
  }
  File.WriteAllText(Path.Combine(directory,"detached-dates.json"),JsonSerializer.Serialize(results));
  Application.DocumentManager.MdiActiveDocument.Editor.WriteMessage("\nJCAD_DETACHED_DATES_OK\n");
 }
}
